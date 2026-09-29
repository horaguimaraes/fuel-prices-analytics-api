import { describe, expect, it } from 'vitest';
import { anpUrl } from '../src/etl/download.js';
import {
  decodeBytes, mapHeader, normalizeCnpj, parseCsv, parseDate, parseDecimal, parseRow,
} from '../src/etl/parse.js';
import { HEADER } from './fixtures.js';

describe('parseDecimal', () => {
  it.each([
    ['5,99', 5.99],
    ['1.234,56', 1234.56],
    ['5.99', 5.99],
    ['  6,5 ', 6.5],
    ['109,90', 109.9],
  ])('%s -> %d', (input, expected) => expect(parseDecimal(input)).toBeCloseTo(expected, 6));

  it.each(['', 'abc', '5,9x', '--', '5,,9'])('rejects %j', (input) => expect(parseDecimal(input)).toBeNaN());
});

describe('parseDate', () => {
  it('converts dd/mm/yyyy to ISO', () => expect(parseDate('31/08/2026')).toBe('2026-08-31'));
  it('passes ISO through', () => expect(parseDate('2026-08-31')).toBe('2026-08-31'));
  it('rejects impossible dates', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('29/02/2025')).toBeNull();
    expect(parseDate('29/02/2028')).toBe('2028-02-29');
    expect(parseDate('2026-13-01')).toBeNull();
  });
  it('rejects other formats', () => {
    expect(parseDate('1/9/2026')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('normalizeCnpj', () => {
  it('strips punctuation and the leading space', () => expect(normalizeCnpj(' 88.587.589/0001-17')).toBe('88587589000117'));
  it('left-pads 13 digits (lost leading zero)', () => expect(normalizeCnpj('8587589000117')).toBe('08587589000117'));
  it('rejects wrong lengths', () => {
    expect(normalizeCnpj('123')).toBeNull();
    expect(normalizeCnpj('')).toBeNull();
    expect(normalizeCnpj('123456789012345')).toBeNull();
  });
});

describe('decodeBytes', () => {
  it('strips the UTF-8 BOM', () => {
    expect(decodeBytes(new TextEncoder().encode('﻿abc'))).toBe('abc');
  });
  it('falls back to Latin-1 for older files', () => {
    const latin1 = Uint8Array.from([0x53, 0x41, 0x42, 0x42, 0xc1]); // "SABBÁ" in Latin-1
    expect(decodeBytes(latin1)).toBe('SABBÁ');
  });
});

describe('parseCsv', () => {
  it('handles CRLF, LF, blank lines and a missing final newline', () => {
    expect([...parseCsv('a;b\r\nc;d\n\ne;f')]).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  });
  it('handles quoted fields with delimiters, quotes and newlines', () => {
    expect([...parseCsv('"a;1";"say ""hi""";"line1\nline2"\r\n')]).toEqual([['a;1', 'say "hi"', 'line1\nline2']]);
  });
  it('keeps empty fields', () => expect([...parseCsv('a;;c;')]).toEqual([['a', '', 'c', '']]));
});

describe('mapHeader', () => {
  it('finds columns regardless of order, accents or case', () => {
    const shuffled = HEADER.split(';').reverse();
    const idx = mapHeader(shuffled);
    expect(shuffled[idx.price]).toBe('Valor de Venda');
    expect(shuffled[idx.cnpj]).toBe('CNPJ da Revenda');
  });
  it('explains what is missing when the file is not an ANP file', () => {
    expect(() => mapHeader(['a', 'b'])).toThrow(/Not an ANP price file.*produto/);
  });
});

describe('parseRow', () => {
  const col = mapHeader(HEADER.split(';'));
  const base = ['SE', 'RJ', 'NITEROI', 'POSTO X', ' 33.333.333/0001-33', 'RUA A', '10', '', 'CENTRO', '24000-000', 'GASOLINA', '01/09/2026', '6,99', '', 'R$ / litro', 'VIBRA'];
  const withCell = (name: keyof typeof col, value: string) => base.map((v, i) => (i === col[name] ? value : v));

  it('accepts a valid row and normalises it', () => {
    const r = parseRow(base, col, 16);
    expect(r).toMatchObject({ ok: true, record: { cnpj: '33333333000133', price: 6.99, collectedOn: '2026-09-01', product: 'GASOLINA', purchasePrice: null } });
  });

  it.each([
    ['cnpj', '', 'missing_cnpj'],
    ['cnpj', '12345', 'invalid_cnpj'],
    ['collectedOn', '32/01/2026', 'invalid_date'],
    ['price', 'n/a', 'invalid_price'],
    ['price', '0,00', 'price_out_of_range'],
    ['price', '9999,00', 'price_out_of_range'],
    ['state', 'RJX', 'missing_field'],
    ['brand', '', 'missing_field'],
  ] as const)('rejects %s=%j as %s', (name, value, reason) => {
    expect(parseRow(withCell(name, value), col, 16)).toEqual({ ok: false, reason });
  });

  it('rejects rows with the wrong number of columns', () => {
    expect(parseRow(base.slice(0, 10), col, 16)).toEqual({ ok: false, reason: 'wrong_column_count' });
  });

  it('accepts LPG-sized prices (R$ per 13 kg cylinder)', () => {
    expect(parseRow(withCell('price', '132,50'), col, 16)).toMatchObject({ ok: true });
  });
});

describe('anpUrl', () => {
  it('builds the rolling 4-week URL', () => {
    expect(anpUrl('last4weeks:diesel-gnv')).toBe(
      'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-diesel-gnv.csv'
    );
  });
  it('builds a monthly URL', () => {
    expect(anpUrl('2026-08:gasolina-etanol')).toBe(
      'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/dsan/2026/08-dados-abertos-precos-2026-08-gasolina-etanol.csv'
    );
  });
  it.each(['nope', '2026-13:glp', '2026-08:coal', ':glp', '2026-8:glp'])('rejects %j', (spec) => {
    expect(() => anpUrl(spec)).toThrow();
  });
});
