import type { SQLInputValue } from 'node:sqlite';
import type { Db } from '../db/connection.js';

export interface Filters {
  product?: string;
  state?: string;
  city?: string;
  brand?: string;
  from?: string;
  to?: string;
}

type Row = Record<string, unknown>;

/** Build a parameterised WHERE clause. Values are always bound, never concatenated into SQL. */
function where(f: Filters): { clause: string; params: Record<string, SQLInputValue> } {
  const conditions: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  const add = (sql: string, key: string, value: string | undefined) => {
    if (value === undefined) return;
    conditions.push(sql);
    params[key] = value;
  };
  add('product = :product', 'product', f.product);
  add('state = :state', 'state', f.state);
  add('city = :city', 'city', f.city);
  add('brand = :brand', 'brand', f.brand);
  add('collected_on >= :from', 'from', f.from);
  add('collected_on <= :to', 'to', f.to);
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Prices are shown to 3 decimals (ANP publishes 2; averages need a little more). */
export const round = (v: unknown, digits = 3): number | null => {
  const n = num(v);
  return n === null ? null : Number(n.toFixed(digits));
};

export function productExists(db: Db, name: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM products WHERE name = :name').get({ name }) !== undefined;
}

export function listProducts(db: Db) {
  const rows = db.prepare(`
    SELECT p.name, p.unit, COUNT(*) AS observations, MIN(pr.collected_on) AS first_date, MAX(pr.collected_on) AS last_date
    FROM products p JOIN prices pr ON pr.product = p.name
    GROUP BY p.name, p.unit ORDER BY p.name`).all() as Row[];
  return rows.map((r) => ({
    name: String(r.name), unit: String(r.unit), observations: Number(r.observations),
    firstDate: String(r.first_date), lastDate: String(r.last_date),
  }));
}

export function meta(db: Db) {
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM stations) AS stations, (SELECT COUNT(*) FROM prices) AS observations,
           (SELECT MIN(collected_on) FROM prices) AS first_date, (SELECT MAX(collected_on) FROM prices) AS last_date`
  ).get() as Row;
  const last = db.prepare('SELECT source, finished_at, rows_accepted, rows_rejected FROM ingest_runs ORDER BY id DESC LIMIT 1').get() as Row | undefined;
  const states = db.prepare('SELECT state, COUNT(*) AS stations FROM stations GROUP BY state ORDER BY state').all() as Row[];
  return {
    stations: Number(totals.stations),
    observations: Number(totals.observations),
    firstDate: (totals.first_date as string | null) ?? null,
    lastDate: (totals.last_date as string | null) ?? null,
    states: states.map((s) => ({ state: String(s.state), stations: Number(s.stations) })),
    lastIngest: last
      ? { source: String(last.source), finishedAt: String(last.finished_at), rowsAccepted: Number(last.rows_accepted), rowsRejected: Number(last.rows_rejected) }
      : null,
  };
}

/** min / avg / median / max for a slice of the data. The median uses a window function. */
export function summary(db: Db, f: Filters) {
  const { clause, params } = where(f);
  const row = db.prepare(`
    WITH f AS (SELECT price, station_cnpj FROM v_price_facts ${clause}),
    ranked AS (SELECT price, ROW_NUMBER() OVER (ORDER BY price) AS rn, COUNT(*) OVER () AS cnt FROM f)
    SELECT COUNT(*) AS observations, COUNT(DISTINCT station_cnpj) AS stations,
           MIN(price) AS min, AVG(price) AS avg, MAX(price) AS max,
           (SELECT AVG(price) FROM ranked WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)) AS median
    FROM f`).get(params) as Row;
  return {
    observations: Number(row.observations), stations: Number(row.stations),
    min: round(row.min), avg: round(row.avg), median: round(row.median), max: round(row.max),
  };
}

export type Granularity = 'day' | 'week';

/** Average price over time with a 7-period moving average and the change vs the previous period. */
export function trend(db: Db, f: Filters, granularity: Granularity) {
  const { clause, params } = where(f);
  // Monday of the week that contains the date ('weekday 0' = next Sunday, minus 6 days).
  const bucket = granularity === 'week' ? "date(collected_on, 'weekday 0', '-6 days')" : 'collected_on';
  const rows = db.prepare(`
    WITH bucketed AS (
      SELECT ${bucket} AS period, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price,
             COUNT(*) AS observations, COUNT(DISTINCT station_cnpj) AS stations
      FROM v_price_facts ${clause} GROUP BY period)
    SELECT period, avg_price, min_price, max_price, observations, stations,
           AVG(avg_price) OVER (ORDER BY period ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg_7,
           avg_price - LAG(avg_price) OVER (ORDER BY period) AS change
    FROM bucketed ORDER BY period`).all(params) as Row[];
  return rows.map((r) => ({
    period: String(r.period), avg: round(r.avg_price), min: round(r.min_price), max: round(r.max_price),
    observations: Number(r.observations), stations: Number(r.stations),
    movingAvg7: round(r.moving_avg_7), change: round(r.change),
  }));
}

export type GroupBy = 'state' | 'brand' | 'city';

/**
 * Ranking by state / brand / city, cheapest first, with the gap vs the (observation-weighted)
 * average of the whole filtered slice. Small groups are dropped to keep rankings meaningful.
 */
export function ranking(db: Db, f: Filters, groupBy: GroupBy, minStations: number) {
  const { clause, params } = where(f);
  const column = { state: 'state', brand: 'brand', city: 'city' }[groupBy]; // whitelist, never user input
  const rows = db.prepare(`
    WITH grouped AS (
      SELECT ${column} AS grp, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price,
             COUNT(*) AS observations, COUNT(DISTINCT station_cnpj) AS stations
      FROM v_price_facts ${clause} GROUP BY ${column} HAVING COUNT(DISTINCT station_cnpj) >= :minStations)
    SELECT grp, avg_price, min_price, max_price, observations, stations,
           RANK() OVER (ORDER BY avg_price ASC) AS rank_cheapest,
           avg_price / (SUM(avg_price * observations) OVER () / SUM(observations) OVER ()) - 1 AS vs_average
    FROM grouped ORDER BY avg_price ASC, grp`).all({ ...params, minStations }) as Row[];
  return rows.map((r) => ({
    [groupBy]: String(r.grp), avg: round(r.avg_price), min: round(r.min_price), max: round(r.max_price),
    observations: Number(r.observations), stations: Number(r.stations),
    rankCheapest: Number(r.rank_cheapest), vsAveragePct: round(Number(r.vs_average) * 100, 2),
  }));
}

/** Latest price per station (ROW_NUMBER over station), then cheapest or most expensive first. */
export function stationsByPrice(db: Db, f: Filters, order: 'asc' | 'desc', limit: number, offset: number) {
  const { clause, params } = where(f);
  const direction = order === 'desc' ? 'DESC' : 'ASC'; // whitelist
  const latest = `
    WITH latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY station_cnpj ORDER BY collected_on DESC) AS rn
      FROM v_price_facts ${clause})`;
  const rows = db.prepare(`${latest}
    SELECT station_cnpj, station_name, brand, state, city, neighborhood, price, collected_on
    FROM latest WHERE rn = 1 ORDER BY price ${direction}, collected_on DESC, station_cnpj
    LIMIT :limit OFFSET :offset`).all({ ...params, limit, offset }) as Row[];
  const total = Number((db.prepare(`SELECT COUNT(DISTINCT station_cnpj) AS n FROM v_price_facts ${clause}`).get(params) as Row).n);
  return {
    total,
    items: rows.map((r) => ({
      cnpj: String(r.station_cnpj), name: String(r.station_name), brand: String(r.brand), state: String(r.state),
      city: String(r.city), neighborhood: (r.neighborhood as string | null) || null,
      price: round(r.price), collectedOn: String(r.collected_on),
    })),
  };
}

export function stationDetail(db: Db, cnpj: string) {
  const s = db.prepare('SELECT * FROM stations WHERE cnpj = :cnpj').get({ cnpj }) as Row | undefined;
  if (!s) return null;
  const latest = db.prepare(`
    SELECT product, price, collected_on FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY product ORDER BY collected_on DESC) AS rn FROM prices WHERE station_cnpj = :cnpj)
    WHERE rn = 1 ORDER BY product`).all({ cnpj }) as Row[];
  return {
    cnpj: String(s.cnpj), name: String(s.name), brand: String(s.brand), region: String(s.region), state: String(s.state),
    city: String(s.city), neighborhood: (s.neighborhood as string | null) || null,
    address: [s.street, s.street_number, s.complement].filter(Boolean).join(', ') || null, zip: (s.zip as string | null) || null,
    latestPrices: latest.map((r) => ({ product: String(r.product), price: round(r.price), collectedOn: String(r.collected_on) })),
  };
}

export function stationPrices(db: Db, cnpj: string, f: Filters) {
  const { clause, params } = where(f);
  const extra = clause ? `${clause} AND` : 'WHERE';
  const rows = db.prepare(`
    SELECT product, collected_on, price, purchase_price FROM v_price_facts ${extra} station_cnpj = :cnpj
    ORDER BY collected_on, product`).all({ ...params, cnpj }) as Row[];
  return rows.map((r) => ({
    product: String(r.product), collectedOn: String(r.collected_on), price: round(r.price), purchasePrice: round(r.purchase_price),
  }));
}

/** Daily state-level aggregates: a tidy fact table for BI tools. */
export function stateDaily(db: Db, f: Filters) {
  const { clause, params } = where(f);
  const rows = db.prepare(`
    SELECT collected_on AS date, state, product, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price,
           COUNT(*) AS observations, COUNT(DISTINCT station_cnpj) AS stations
    FROM v_price_facts ${clause} GROUP BY collected_on, state, product ORDER BY collected_on, state, product`).all(params) as Row[];
  return rows.map((r) => ({
    date: String(r.date), state: String(r.state), product: String(r.product), avg: round(r.avg_price), min: round(r.min_price),
    max: round(r.max_price), observations: Number(r.observations), stations: Number(r.stations),
  }));
}

/** Station dimension table for BI tools. */
export function stationDimension(db: Db, f: Pick<Filters, 'state' | 'brand'>) {
  const { clause, params } = where(f);
  const rows = db.prepare(`
    SELECT cnpj, name, brand, region, state, city, neighborhood, zip FROM stations ${clause} ORDER BY state, city, name`).all(params) as Row[];
  return rows.map((r) => ({
    cnpj: String(r.cnpj), name: String(r.name), brand: String(r.brand), region: String(r.region), state: String(r.state),
    city: String(r.city), neighborhood: (r.neighborhood as string | null) || '', zip: (r.zip as string | null) || '',
  }));
}

/**
 * Ethanol vs gasoline per state. Rule of thumb: ethanol has ~70% of gasoline's energy content,
 * so it is the cheaper choice per km when its price is below 70% of gasoline's.
 */
export const ETHANOL_PARITY = 0.7;

export function ethanolParity(db: Db, f: Pick<Filters, 'state' | 'from' | 'to'>) {
  const { clause, params } = where(f);
  const base = clause ? `${clause} AND product IN ('GASOLINA', 'ETANOL')` : "WHERE product IN ('GASOLINA', 'ETANOL')";
  const rows = db.prepare(`
    WITH avg_by AS (
      SELECT state, product, AVG(price) AS avg_price, COUNT(DISTINCT station_cnpj) AS stations
      FROM v_price_facts ${base} GROUP BY state, product)
    SELECT g.state, e.avg_price AS ethanol, g.avg_price AS gasoline, e.avg_price / g.avg_price AS ratio,
           e.stations AS ethanol_stations, g.stations AS gasoline_stations
    FROM avg_by g JOIN avg_by e ON e.state = g.state AND e.product = 'ETANOL'
    WHERE g.product = 'GASOLINA' ORDER BY ratio, g.state`).all(params) as Row[];
  return rows.map((r) => ({
    state: String(r.state), ethanolAvg: round(r.ethanol), gasolineAvg: round(r.gasoline),
    ratioPct: round(Number(r.ratio) * 100, 1), cheaperPerKm: Number(r.ratio) < ETHANOL_PARITY ? 'ETANOL' : 'GASOLINA',
    ethanolStations: Number(r.ethanol_stations), gasolineStations: Number(r.gasoline_stations),
  }));
}
