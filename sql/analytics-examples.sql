-- Analytical SQL on top of the schema in src/db/schema.ts.
-- Run any of these with:  sqlite3 data/fuel.db < sql/analytics-examples.sql
-- They are executed against a fixture database in tests/sql-examples.test.ts, so they cannot rot.
--
-- Everything reads from the view v_price_facts (one row per price observation + station attributes).

-- name: week-over-week change per state (LAG over a partition)
WITH weekly AS (
  SELECT state,
         date(collected_on, 'weekday 0', '-6 days') AS week,   -- Monday of the week
         AVG(price) AS avg_price
  FROM v_price_facts
  WHERE product = 'GASOLINA'
  GROUP BY state, week
)
SELECT state,
       week,
       ROUND(avg_price, 3) AS avg_price,
       ROUND(avg_price - LAG(avg_price) OVER (PARTITION BY state ORDER BY week), 3) AS change_vs_prev_week
FROM weekly
ORDER BY state, week;

-- name: stations priced below or above their city average (window AVG over a partition)
WITH latest AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY station_cnpj ORDER BY collected_on DESC) AS rn
  FROM v_price_facts
  WHERE product = 'GASOLINA'
)
SELECT station_name, city, state, price,
       ROUND(AVG(price) OVER (PARTITION BY state, city), 3)          AS city_avg,
       ROUND(price - AVG(price) OVER (PARTITION BY state, city), 3)  AS vs_city_avg
FROM latest
WHERE rn = 1
ORDER BY vs_city_avg
LIMIT 20;

-- name: price dispersion by city (spread and variance, cities with 5+ stations)
SELECT state, city,
       COUNT(DISTINCT station_cnpj)                       AS stations,
       ROUND(MIN(price), 2)                               AS min_price,
       ROUND(MAX(price), 2)                               AS max_price,
       ROUND(MAX(price) - MIN(price), 2)                  AS spread,
       ROUND(AVG(price * price) - AVG(price) * AVG(price), 4) AS variance
FROM v_price_facts
WHERE product = 'GASOLINA'
GROUP BY state, city
HAVING COUNT(DISTINCT station_cnpj) >= 5
ORDER BY spread DESC
LIMIT 20;

-- name: brand share of stations within each state (window SUM over aggregates)
SELECT state, brand,
       COUNT(DISTINCT station_cnpj) AS stations,
       ROUND(100.0 * COUNT(DISTINCT station_cnpj) / SUM(COUNT(DISTINCT station_cnpj)) OVER (PARTITION BY state), 1) AS pct_of_state
FROM v_price_facts
WHERE product = 'GASOLINA'
GROUP BY state, brand
ORDER BY state, stations DESC;

-- name: ethanol vs gasoline, the 70 percent rule (self-join on aggregated CTE)
WITH avg_by AS (
  SELECT state, product, AVG(price) AS avg_price
  FROM v_price_facts
  WHERE product IN ('GASOLINA', 'ETANOL')
  GROUP BY state, product
)
SELECT g.state,
       ROUND(e.avg_price, 3)                    AS ethanol,
       ROUND(g.avg_price, 3)                    AS gasoline,
       ROUND(100.0 * e.avg_price / g.avg_price, 1) AS ethanol_pct_of_gasoline,
       CASE WHEN e.avg_price / g.avg_price < 0.70 THEN 'ETANOL' ELSE 'GASOLINA' END AS cheaper_per_km
FROM avg_by g
JOIN avg_by e ON e.state = g.state AND e.product = 'ETANOL'
WHERE g.product = 'GASOLINA'
ORDER BY 4;

-- name: stations whose price never changed across observations (candidates for stale data)
SELECT station_cnpj, station_name, city, state, product,
       COUNT(*)                AS observations,
       MIN(price)              AS price
FROM v_price_facts
GROUP BY station_cnpj, product
HAVING COUNT(*) >= 3 AND MIN(price) = MAX(price)
ORDER BY observations DESC
LIMIT 20;
