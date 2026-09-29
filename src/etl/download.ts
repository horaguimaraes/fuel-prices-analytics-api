import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const BASE = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc';

export const ANP_KINDS = ['gasolina-etanol', 'diesel-gnv', 'glp'] as const;
export type AnpKind = (typeof ANP_KINDS)[number];

/**
 * Build the official download URL from a short spec:
 *   "last4weeks:gasolina-etanol"   rolling 4-week file (updated weekly)
 *   "2026-08:diesel-gnv"           monthly file (available from 2023)
 */
export function anpUrl(spec: string): string {
  const [period, kind] = spec.split(':');
  if (!period || !kind || !(ANP_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid --anp spec "${spec}". Use <last4weeks|YYYY-MM>:<${ANP_KINDS.join('|')}>`);
  }
  if (period === 'last4weeks') return `${BASE}/qus/ultimas-4-semanas-${kind}.csv`;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new Error(`Invalid period "${period}". Use last4weeks or YYYY-MM`);
  const [, year, month] = m;
  return `${BASE}/dsan/${year}/${month}-dados-abertos-precos-${year}-${month}-${kind}.csv`;
}

/** Download a file to `dir` and return its local path. */
export async function download(url: string, dir: string): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https URLs are allowed');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  await mkdir(dir, { recursive: true });
  const target = join(dir, basename(new URL(url).pathname) || 'download.csv');
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  return target;
}
