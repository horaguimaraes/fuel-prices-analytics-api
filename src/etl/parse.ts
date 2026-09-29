/**
 * Parsing and validation of the ANP "Série histórica de preços de combustíveis" CSV files.
 *
 * Format (verified against the official files): `;` separated, UTF-8 with BOM, CRLF,
 * decimal comma (`5,99`), dates as dd/mm/yyyy, CNPJ with punctuation and a leading space.
 */

export interface PriceRecord {
  cnpj: string;
  stationName: string;
  brand: string;
  region: string;
  state: string;
  city: string;
  neighborhood: string;
  street: string;
  streetNumber: string;
  complement: string;
  zip: string;
  product: string;
  unit: string;
  collectedOn: string; // YYYY-MM-DD
  price: number;
  purchasePrice: number | null;
}

export type RejectReason =
  | 'wrong_column_count'
  | 'missing_cnpj'
  | 'invalid_cnpj'
  | 'missing_field'
  | 'invalid_date'
  | 'invalid_price'
  | 'price_out_of_range';

export type ParsedRow = { ok: true; record: PriceRecord } | { ok: false; reason: RejectReason };

// Sanity bounds. Wide on purpose: LPG is sold per 13 kg cylinder (~R$ 100+), fuels per litre (~R$ 3-10).
export const MIN_PRICE = 0.1;
export const MAX_PRICE = 500;

/** Decode bytes as UTF-8, falling back to Latin-1 (older ANP series). Strips the BOM. */
export function decodeBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('latin1').decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF/LF, custom delimiter. */
export function* parseCsv(text: string, delimiter = ';'): Generator<string[]> {
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') yield row; // skip blank lines
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const COLUMN_ALIASES = {
  region: 'regiao sigla',
  state: 'estado sigla',
  city: 'municipio',
  stationName: 'revenda',
  cnpj: 'cnpj da revenda',
  street: 'nome da rua',
  streetNumber: 'numero rua',
  complement: 'complemento',
  neighborhood: 'bairro',
  zip: 'cep',
  product: 'produto',
  collectedOn: 'data da coleta',
  price: 'valor de venda',
  purchasePrice: 'valor de compra',
  unit: 'unidade de medida',
  brand: 'bandeira',
} as const;

export type ColumnKey = keyof typeof COLUMN_ALIASES;
export type ColumnIndex = Record<ColumnKey, number>;

/** Map the header row to column positions (order-independent, accent/case-insensitive). */
export function mapHeader(header: string[]): ColumnIndex {
  const folded = header.map(fold);
  const index = {} as ColumnIndex;
  const missing: string[] = [];
  for (const [key, alias] of Object.entries(COLUMN_ALIASES) as [ColumnKey, string][]) {
    const at = folded.indexOf(alias);
    if (at === -1) missing.push(alias); else index[key] = at;
  }
  if (missing.length) {
    throw new Error(`Not an ANP price file. Missing column(s): ${missing.join(', ')}`);
  }
  return index;
}

/** '5,99' -> 5.99, '1.234,56' -> 1234.56, '5.99' -> 5.99. Returns NaN when unparseable. */
export function parseDecimal(value: string): number {
  const text = value.replace(/\s/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) return NaN;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  return Number(normalized);
}

/** dd/mm/yyyy (or yyyy-mm-dd) -> yyyy-mm-dd, rejecting impossible dates such as 31/02. */
export function parseDate(value: string): string | null {
  const text = value.trim();
  let year: number, month: number, day: number;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (m) { day = +m[1]!; month = +m[2]!; year = +m[3]!; }
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) { year = +m[1]!; month = +m[2]!; day = +m[3]!; }
  else return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Keep digits only; ANP sometimes drops the leading zero, so 13 digits are left-padded. */
export function normalizeCnpj(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const padded = digits.length === 13 ? digits.padStart(14, '0') : digits;
  return padded.length === 14 ? padded : null;
}

export function parseRow(cells: string[], col: ColumnIndex, expectedColumns: number): ParsedRow {
  if (cells.length !== expectedColumns) return { ok: false, reason: 'wrong_column_count' };
  const get = (key: ColumnKey) => clean(cells[col[key]]);

  const rawCnpj = get('cnpj');
  if (!rawCnpj) return { ok: false, reason: 'missing_cnpj' };
  const cnpj = normalizeCnpj(rawCnpj);
  if (!cnpj) return { ok: false, reason: 'invalid_cnpj' };

  const collectedOn = parseDate(get('collectedOn'));
  if (!collectedOn) return { ok: false, reason: 'invalid_date' };

  const price = parseDecimal(get('price'));
  if (!Number.isFinite(price)) return { ok: false, reason: 'invalid_price' };
  if (price < MIN_PRICE || price > MAX_PRICE) return { ok: false, reason: 'price_out_of_range' };

  const rawPurchase = get('purchasePrice');
  const purchase = rawPurchase ? parseDecimal(rawPurchase) : NaN;

  const product = get('product').toUpperCase();
  const state = get('state').toUpperCase();
  const stationName = get('stationName');
  const city = get('city').toUpperCase();
  const brand = get('brand').toUpperCase();
  const region = get('region').toUpperCase();
  const unit = get('unit');
  if (!product || state.length !== 2 || !stationName || !city || !brand || !region || !unit) {
    return { ok: false, reason: 'missing_field' };
  }

  return {
    ok: true,
    record: {
      cnpj, stationName, brand, region, state, city, product, unit, collectedOn, price,
      neighborhood: get('neighborhood'),
      street: get('street'),
      streetNumber: get('streetNumber'),
      complement: get('complement'),
      zip: get('zip'),
      purchasePrice: Number.isFinite(purchase) && purchase >= MIN_PRICE && purchase <= MAX_PRICE ? purchase : null,
    },
  };
}
