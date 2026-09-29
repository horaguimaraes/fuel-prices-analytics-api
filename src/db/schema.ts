/**
 * Relational model for the ANP fuel price survey.
 *
 *   products ─┐
 *             ├─< prices >─ stations
 *   ingest_runs (audit trail, one row per load)
 *
 * Prices are stored as observations keyed by (station, product, collection date), so re-loading
 * the same file is idempotent. Dates are ISO-8601 text (YYYY-MM-DD), which sorts and compares
 * correctly in SQLite.
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS products (
  name TEXT PRIMARY KEY,
  unit TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  cnpj          TEXT PRIMARY KEY CHECK (length(cnpj) = 14 AND cnpj NOT GLOB '*[^0-9]*'),
  name          TEXT NOT NULL,
  brand         TEXT NOT NULL,
  region        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (length(state) = 2),
  city          TEXT NOT NULL,
  neighborhood  TEXT,
  street        TEXT,
  street_number TEXT,
  complement    TEXT,
  zip           TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  station_cnpj   TEXT NOT NULL REFERENCES stations (cnpj) ON DELETE CASCADE,
  product        TEXT NOT NULL REFERENCES products (name),
  collected_on   TEXT NOT NULL CHECK (collected_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  price          REAL NOT NULL CHECK (price > 0),
  purchase_price REAL CHECK (purchase_price IS NULL OR purchase_price > 0),
  PRIMARY KEY (station_cnpj, product, collected_on)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_prices_product_date ON prices (product, collected_on);
CREATE INDEX IF NOT EXISTS idx_stations_state_city ON stations (state, city);
CREATE INDEX IF NOT EXISTS idx_stations_brand      ON stations (brand);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT NOT NULL,
  rows_read      INTEGER NOT NULL,
  rows_accepted  INTEGER NOT NULL,
  rows_inserted  INTEGER NOT NULL,
  rows_rejected  INTEGER NOT NULL,
  rejects_json   TEXT NOT NULL
);

-- Flat fact view: one row per observation with the station attributes attached.
-- The API and the Power BI queries read from this instead of repeating the join.
CREATE VIEW IF NOT EXISTS v_price_facts AS
SELECT p.station_cnpj,
       s.name  AS station_name,
       s.brand,
       s.region,
       s.state,
       s.city,
       s.neighborhood,
       p.product,
       p.collected_on,
       p.price,
       p.purchase_price
FROM prices p
JOIN stations s ON s.cnpj = p.station_cnpj;
`;
