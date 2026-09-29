import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { ingestCsv } from '../src/etl/ingest.js';
import { A, B, csv, FIXTURE_ROWS, fixtureDb, HEADER } from './fixtures.js';

const scalar = (db: ReturnType<typeof openDatabase>, sql: string) => Object.values(db.prepare(sql).get() as object)[0];

describe('ingestCsv', () => {
  it('loads stations, products and prices and reports the result', () => {
    const db = openDatabase(':memory:');
    const result = ingestCsv(db, csv(FIXTURE_ROWS), 'x.csv');
    expect(result).toMatchObject({ rowsRead: 9, rowsAccepted: 9, rowsInserted: 9, rowsRejected: 0, rejectsByReason: {} });
    expect(result.dateRange).toEqual({ from: '2026-09-01', to: '2026-09-08' });
    expect(scalar(db, 'SELECT COUNT(*) FROM stations')).toBe(5);
    expect(scalar(db, 'SELECT COUNT(*) FROM products')).toBe(2);
    expect(scalar(db, 'SELECT COUNT(*) FROM prices')).toBe(9);
  });

  it('is idempotent: loading the same file twice adds nothing', () => {
    const db = fixtureDb();
    const again = ingestCsv(db, csv(FIXTURE_ROWS), 'x.csv');
    expect(again).toMatchObject({ rowsAccepted: 9, rowsInserted: 0 });
    expect(scalar(db, 'SELECT COUNT(*) FROM prices')).toBe(9);
  });

  it('lets a later file correct an earlier price', () => {
    const db = fixtureDb();
    ingestCsv(db, csv([{ cnpj: A, brand: 'BRANCA', state: 'SP', city: 'SAO PAULO', product: 'GASOLINA', date: '01/09/2026', price: '5,55' }]), 'fix.csv');
    expect(scalar(db, `SELECT price FROM prices WHERE station_cnpj='${A}' AND product='GASOLINA' AND collected_on='2026-09-01'`)).toBe(5.55);
    expect(scalar(db, 'SELECT COUNT(*) FROM prices')).toBe(9);
  });

  it('updates station attributes when a brand changes', () => {
    const db = fixtureDb();
    ingestCsv(db, csv([{ cnpj: B, brand: 'IPIRANGA', state: 'SP', city: 'CAMPINAS', product: 'GASOLINA', date: '15/09/2026', price: '6,60' }]), 'x.csv');
    expect(scalar(db, `SELECT brand FROM stations WHERE cnpj='${B}'`)).toBe('IPIRANGA');
  });

  it('counts bad rows by reason and keeps the good ones', () => {
    const db = openDatabase(':memory:');
    const good = { cnpj: A, brand: 'BRANCA', state: 'SP', product: 'GASOLINA', date: '01/09/2026', price: '6,00' };
    const text = csv([
      good,
      { ...good, date: '31/02/2026' },
      { ...good, price: 'abc' },
      { ...good, price: '0,00' },
      { ...good, cnpj: '123' },
    ]);
    const result = ingestCsv(db, text, 'x.csv');
    expect(result).toMatchObject({ rowsRead: 5, rowsAccepted: 1, rowsRejected: 4 });
    expect(result.rejectsByReason).toEqual({ invalid_date: 1, invalid_price: 1, price_out_of_range: 1, invalid_cnpj: 1 });
    expect(scalar(db, 'SELECT COUNT(*) FROM prices')).toBe(1);
  });

  it('records an audit row for every run', () => {
    const db = fixtureDb();
    const run = db.prepare('SELECT source, rows_read, rows_inserted, rows_rejected FROM ingest_runs').get() as Record<string, unknown>;
    expect(run).toMatchObject({ source: 'fixture.csv', rows_read: 9, rows_inserted: 9, rows_rejected: 0 });
  });

  it('rejects a file that is not in the ANP format, leaving no trace', () => {
    const db = openDatabase(':memory:');
    expect(() => ingestCsv(db, 'a;b\r\n1;2\r\n', 'bad.csv')).toThrow(/Not an ANP price file/);
    expect(() => ingestCsv(db, '', 'empty.csv')).toThrow(/empty/);
    expect(scalar(db, 'SELECT COUNT(*) FROM ingest_runs')).toBe(0);
  });

  it('rolls back everything if the load fails midway', () => {
    const db = openDatabase(':memory:');
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON prices WHEN NEW.price = 6.66 BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const rows = [
      { cnpj: A, brand: 'BRANCA', state: 'SP', product: 'GASOLINA', date: '01/09/2026', price: '6,00' },
      { cnpj: A, brand: 'BRANCA', state: 'SP', product: 'GASOLINA', date: '02/09/2026', price: '6,66' },
    ];
    expect(() => ingestCsv(db, csv(rows), 'x.csv')).toThrow(/boom/);
    expect(scalar(db, 'SELECT COUNT(*) FROM prices')).toBe(0);
    expect(scalar(db, 'SELECT COUNT(*) FROM stations')).toBe(0);
    // and the connection is still usable afterwards
    expect(ingestCsv(db, csv(rows.slice(0, 1)), 'y.csv').rowsInserted).toBe(1);
  });

  it('enforces integrity in the schema itself', () => {
    const db = fixtureDb();
    expect(() => db.exec("INSERT INTO prices VALUES ('99999999999999','GASOLINA','2026-09-01',6,NULL)")).toThrow(); // unknown station
    expect(() => db.exec(`INSERT INTO prices VALUES ('${A}','GASOLINA','2026-09-09',-1,NULL)`)).toThrow(); // price > 0
    expect(() => db.exec(`INSERT INTO prices VALUES ('${A}','GASOLINA','09/09/2026',6,NULL)`)).toThrow(); // ISO date
  });

  it('accepts columns in a different order', () => {
    const db = openDatabase(':memory:');
    const cols = HEADER.split(';');
    const order = [...cols.keys()].reverse();
    const source = csv(FIXTURE_ROWS).replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => l.split(';'));
    const reversed = source.map((cells) => order.map((i) => cells[i]).join(';')).join('\r\n');
    expect(ingestCsv(db, reversed, 'r.csv')).toMatchObject({ rowsAccepted: 9, rowsRejected: 0 });
  });
});
