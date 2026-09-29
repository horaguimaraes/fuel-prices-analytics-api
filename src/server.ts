import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = buildApp(db, config);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
const empty = (db.prepare('SELECT COUNT(*) AS n FROM prices').get() as { n: number }).n === 0;
console.log(`Fuel prices API listening on http://localhost:${config.port}  (docs: /docs)`);
if (empty) console.warn('The database is empty. Load data first: npm run ingest:sample');
if (!config.apiKey) console.warn('API_KEY is not set: the API is open. Set it to require an x-api-key header.');
