import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const BASE = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc';

export const ANP_KINDS = ['gasolina-etanol', 'diesel-gnv', 'glp'] as const;
export type AnpKind = (typeof ANP_KINDS)[number];

/**
 * Candidate download URLs for a short spec, most likely first. ANP has renamed its monthly files over time
 * (verified against the live portal), so there is more than one shape to try:
 *
 *   "last4weeks:gasolina-etanol"   rolling 4-week file (updated weekly)
 *   "2025-03:diesel-gnv"           monthly file, 2023-01..2025-12 use  precos-<fuel>-MM.csv
 *   "2026-08:diesel-gnv"           recent months use                   MM-dados-abertos-precos-YYYY-MM-<fuel>.csv
 *
 * Not every month is published (July 2026 was missing when this was checked); for those, the semester
 * ZIP archive under /dsas/ca/ has the data.
 */
export function anpUrls(spec: string): string[] {
  const [period, kind] = spec.split(':');
  if (!period || !kind || !(ANP_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid --anp spec "${spec}". Use <last4weeks|YYYY-MM>:<${ANP_KINDS.join('|')}>`);
  }
  if (period === 'last4weeks') return [`${BASE}/qus/ultimas-4-semanas-${kind}.csv`];
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new Error(`Invalid period "${period}". Use last4weeks or YYYY-MM`);
  const [, year, month] = m;
  return [
    `${BASE}/dsan/${year}/precos-${kind}-${month}.csv`,
    `${BASE}/dsan/${year}/${month}-dados-abertos-precos-${year}-${month}-${kind}.csv`,
  ];
}

/** Download the first URL that exists (404 means "try the next one"). Returns the local path. */
export async function downloadFirst(urls: string[], dir: string): Promise<string> {
  for (const url of urls) {
    if (!/^https:\/\//i.test(url)) throw new Error('Only https URLs are allowed');
    const response = await fetch(url, { redirect: 'follow' });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    await mkdir(dir, { recursive: true });
    const target = join(dir, basename(new URL(url).pathname) || 'download.csv');
    await writeFile(target, new Uint8Array(await response.arrayBuffer()));
    return target;
  }
  throw new Error(`Not published (HTTP 404). Tried:\n  ${urls.join('\n  ')}`);
}
