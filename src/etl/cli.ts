import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { anpUrls, downloadFirst } from './download.js';
import { ingestCsv } from './ingest.js';
import { decodeBytes } from './parse.js';

const HELP = `Usage: npm run ingest -- [options] [file.csv ...]

  --anp <spec>   download from ANP: <last4weeks|YYYY-MM>:<gasolina-etanol|diesel-gnv|glp>
  --url <url>    download any https CSV in the ANP format
  --db <path>    database file (default: $DB_PATH or data/fuel.db)
  -h, --help     show this help

Examples:
  npm run ingest -- data/sample/anp-sample.csv
  npm run ingest -- --anp last4weeks:gasolina-etanol --anp last4weeks:diesel-gnv
  npm run ingest -- --anp 2026-08:gasolina-etanol
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      anp: { type: 'string', multiple: true },
      url: { type: 'string', multiple: true },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(HELP); return 0; }

  const files = [...positionals];
  const downloads = [...(values.anp ?? []).map(anpUrls), ...(values.url ?? []).map((u) => [u])];
  if (!files.length && !downloads.length) { console.error(HELP); return 1; }

  for (const candidates of downloads) {
    console.log(`Downloading ${candidates[0]}`);
    files.push(await downloadFirst(candidates, 'downloads'));
  }

  const db = openDatabase(values.db ?? loadConfig().dbPath);
  let failed = false;
  for (const file of files) {
    try {
      const result = ingestCsv(db, decodeBytes(await readFile(file)), file);
      console.log(
        `\n${file}\n` +
        `  read ${result.rowsRead.toLocaleString()} | accepted ${result.rowsAccepted.toLocaleString()} | ` +
        `new ${result.rowsInserted.toLocaleString()} | rejected ${result.rowsRejected.toLocaleString()} | ${result.durationMs} ms`
      );
      if (result.dateRange) console.log(`  dates ${result.dateRange.from} -> ${result.dateRange.to}`);
      for (const [reason, n] of Object.entries(result.rejectsByReason)) console.log(`  rejected (${reason}): ${n}`);
    } catch (error) {
      failed = true;
      console.error(`\n${file}: ${(error as Error).message}`);
    }
  }
  db.close();
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
