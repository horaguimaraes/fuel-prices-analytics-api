import { openDatabase, type Db } from '../src/db/connection.js';
import { ingestCsv } from '../src/etl/ingest.js';

export const HEADER =
  'Regiao - Sigla;Estado - Sigla;Municipio;Revenda;CNPJ da Revenda;Nome da Rua;Numero Rua;Complemento;Bairro;Cep;Produto;Data da Coleta;Valor de Venda;Valor de Compra;Unidade de Medida;Bandeira';

export interface Row {
  cnpj: string; // 14 digits
  name?: string;
  brand: string;
  state: string;
  city?: string;
  product: string;
  date: string; // dd/mm/yyyy
  price: string; // '6,00'
  unit?: string;
}

const REGION: Record<string, string> = { SP: 'SE', RJ: 'SE' };

/** '11111111000111' -> ' 11.111.111/0001-11' (ANP's punctuation, including the leading space). */
const formatCnpj = (c: string) => ` ${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;

export function csv(rows: Row[], header = HEADER): string {
  const lines = rows.map((r) =>
    [
      REGION[r.state] ?? 'N', r.state, r.city ?? 'CITY', r.name ?? `STATION ${r.cnpj.slice(-3)}`, formatCnpj(r.cnpj),
      'RUA A', '10', '', 'CENTRO', '00000-000', r.product, r.date, r.price, '', r.unit ?? 'R$ / litro', r.brand,
    ].join(';')
  );
  return '﻿' + [header, ...lines].join('\r\n') + '\r\n';
}

export const A = '11111111000111'; // SP · BRANCA
export const B = '22222222000122'; // SP · VIBRA
export const C = '33333333000133'; // RJ · VIBRA
export const D = '44444444000144'; // RJ · IPIRANGA
export const E = '55555555000155'; // RJ · BRANCA

/**
 * Hand-computable dataset. GASOLINA observations:
 *   A 6.00 (09-01) 6.20 (09-08) | B 6.50 | C 7.00, 7.10 | D 7.20 | E 6.80
 * -> 7 observations, 5 stations, min 6.00, max 7.20, avg 6.686, median 6.80.
 * RJ only: 6.80 7.00 7.10 7.20 -> avg 7.025, median 7.05 (even count).
 */
export const FIXTURE_ROWS: Row[] = [
  { cnpj: A, brand: 'BRANCA', state: 'SP', city: 'SAO PAULO', product: 'GASOLINA', date: '01/09/2026', price: '6,00' },
  { cnpj: A, brand: 'BRANCA', state: 'SP', city: 'SAO PAULO', product: 'GASOLINA', date: '08/09/2026', price: '6,20' },
  { cnpj: A, brand: 'BRANCA', state: 'SP', city: 'SAO PAULO', product: 'ETANOL', date: '01/09/2026', price: '4,00' },
  { cnpj: B, brand: 'VIBRA', state: 'SP', city: 'CAMPINAS', product: 'GASOLINA', date: '01/09/2026', price: '6,50' },
  { cnpj: C, brand: 'VIBRA', state: 'RJ', city: 'NITEROI', product: 'GASOLINA', date: '01/09/2026', price: '7,00' },
  { cnpj: C, brand: 'VIBRA', state: 'RJ', city: 'NITEROI', product: 'GASOLINA', date: '08/09/2026', price: '7,10' },
  { cnpj: C, brand: 'VIBRA', state: 'RJ', city: 'NITEROI', product: 'ETANOL', date: '01/09/2026', price: '4,50' },
  { cnpj: D, brand: 'IPIRANGA', state: 'RJ', city: 'NITEROI', product: 'GASOLINA', date: '01/09/2026', price: '7,20' },
  { cnpj: E, brand: 'BRANCA', state: 'RJ', city: 'RIO DE JANEIRO', product: 'GASOLINA', date: '01/09/2026', price: '6,80' },
];

export function fixtureDb(rows: Row[] = FIXTURE_ROWS): Db {
  const db = openDatabase(':memory:');
  ingestCsv(db, csv(rows), 'fixture.csv');
  return db;
}
