/**
 * Build the small demo dataset in data/sample from real ANP files.
 *
 * It keeps every row of a fixed number of stations per state (picked deterministically by hashing
 * the CNPJ), so all 27 states and all products are represented and the result is reproducible.
 *
 *   npx tsx scripts/make-sample.ts downloads/ultimas-4-semanas-gasolina-etanol.csv downloads/ultimas-4-semanas-diesel-gnv.csv
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decodeBytes, mapHeader, parseCsv } from '../src/etl/parse.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'per-state': { type: 'string', default: '8' }, out: { type: 'string', default: 'data/sample/anp-sample.csv' } },
});
if (!positionals.length) throw new Error('Pass at least one ANP CSV file');
const perState = Number(values['per-state']);

const quote = (cell: string) => (/[";\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
const hash = (cnpj: string) => createHash('sha1').update(cnpj).digest('hex');

let header: string[] | undefined;
const rows: string[][] = [];
for (const file of positionals) {
  const parsed = [...parseCsv(decodeBytes(readFileSync(file)))];
  header ??= parsed[0]!;
  rows.push(...parsed.slice(1));
}
const col = mapHeader(header!);

const byState = new Map<string, Set<string>>();
for (const r of rows) {
  const state = r[col.state]!.trim();
  const cnpj = r[col.cnpj]!.replace(/\D/g, '');
  (byState.get(state) ?? byState.set(state, new Set()).get(state)!).add(cnpj);
}

const keep = new Set<string>();
for (const cnpjs of byState.values()) {
  [...cnpjs].sort((a, b) => hash(a).localeCompare(hash(b))).slice(0, perState).forEach((c) => keep.add(c));
}

const selected = rows.filter((r) => keep.has(r[col.cnpj]!.replace(/\D/g, '')));
const lines = [header!, ...selected].map((r) => r.map(quote).join(';'));
writeFileSync(values.out!, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
console.log(`${keep.size} stations, ${selected.length} rows -> ${values.out}`);
