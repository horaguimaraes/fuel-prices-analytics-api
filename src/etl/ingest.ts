import type { Db } from '../db/connection.js';
import { mapHeader, parseCsv, parseRow, type RejectReason } from './parse.js';

export interface IngestResult {
  source: string;
  rowsRead: number;
  rowsAccepted: number;
  /** Observations that did not exist before. `rowsAccepted - rowsInserted` were already present. */
  rowsInserted: number;
  rowsRejected: number;
  rejectsByReason: Partial<Record<RejectReason, number>>;
  dateRange: { from: string; to: string } | null;
  durationMs: number;
}

const count = (db: Db, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/**
 * Load ANP CSV text into the database.
 *
 * - Idempotent: observations are keyed by (station, product, date) and upserted, so loading the
 *   same file twice changes nothing, and a later file can correct earlier prices.
 * - Atomic: everything happens in one transaction; a failure leaves the database untouched.
 * - Bad rows never abort the load: they are counted by reason and reported.
 */
export function ingestCsv(db: Db, text: string, source: string): IngestResult {
  const started = new Date();
  const rows = parseCsv(text);
  const header = rows.next();
  if (header.done) throw new Error('The file is empty');
  const columns = mapHeader(header.value);
  const expected = header.value.length;

  const upsertProduct = db.prepare(
    'INSERT INTO products (name, unit) VALUES (:name, :unit) ON CONFLICT(name) DO UPDATE SET unit = excluded.unit'
  );
  const upsertStation = db.prepare(`
    INSERT INTO stations (cnpj, name, brand, region, state, city, neighborhood, street, street_number, complement, zip, updated_at)
    VALUES (:cnpj, :name, :brand, :region, :state, :city, :neighborhood, :street, :streetNumber, :complement, :zip, :now)
    ON CONFLICT(cnpj) DO UPDATE SET
      name = excluded.name, brand = excluded.brand, region = excluded.region, state = excluded.state,
      city = excluded.city, neighborhood = excluded.neighborhood, street = excluded.street,
      street_number = excluded.street_number, complement = excluded.complement, zip = excluded.zip,
      updated_at = excluded.updated_at`);
  const upsertPrice = db.prepare(`
    INSERT INTO prices (station_cnpj, product, collected_on, price, purchase_price)
    VALUES (:cnpj, :product, :collectedOn, :price, :purchasePrice)
    ON CONFLICT(station_cnpj, product, collected_on) DO UPDATE SET
      price = excluded.price, purchase_price = excluded.purchase_price`);

  const now = started.toISOString();
  const rejects: Partial<Record<RejectReason, number>> = {};
  let rowsRead = 0;
  let rowsAccepted = 0;
  let from: string | null = null;
  let to: string | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const before = count(db, 'prices');
    for (const cells of rows) {
      rowsRead++;
      const parsed = parseRow(cells, columns, expected);
      if (!parsed.ok) {
        rejects[parsed.reason] = (rejects[parsed.reason] ?? 0) + 1;
        continue;
      }
      const r = parsed.record;
      upsertProduct.run({ name: r.product, unit: r.unit });
      upsertStation.run({
        cnpj: r.cnpj, name: r.stationName, brand: r.brand, region: r.region, state: r.state, city: r.city,
        neighborhood: r.neighborhood, street: r.street, streetNumber: r.streetNumber,
        complement: r.complement, zip: r.zip, now,
      });
      upsertPrice.run({
        cnpj: r.cnpj, product: r.product, collectedOn: r.collectedOn, price: r.price, purchasePrice: r.purchasePrice,
      });
      rowsAccepted++;
      if (from === null || r.collectedOn < from) from = r.collectedOn;
      if (to === null || r.collectedOn > to) to = r.collectedOn;
    }

    const rowsInserted = count(db, 'prices') - before;
    const rowsRejected = rowsRead - rowsAccepted;
    const finished = new Date();
    db.prepare(`
      INSERT INTO ingest_runs (source, started_at, finished_at, rows_read, rows_accepted, rows_inserted, rows_rejected, rejects_json)
      VALUES (:source, :startedAt, :finishedAt, :rowsRead, :rowsAccepted, :rowsInserted, :rowsRejected, :rejects)`
    ).run({
      source, startedAt: now, finishedAt: finished.toISOString(), rowsRead, rowsAccepted, rowsInserted, rowsRejected,
      rejects: JSON.stringify(rejects),
    });
    db.exec('COMMIT');

    return {
      source, rowsRead, rowsAccepted, rowsInserted, rowsRejected,
      rejectsByReason: rejects,
      dateRange: from && to ? { from, to } : null,
      durationMs: finished.getTime() - started.getTime(),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
