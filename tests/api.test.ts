import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import openapi from '../src/api/openapi.json' with { type: 'json' };
import { A, C, D, FIXTURE_ROWS, fixtureDb } from './fixtures.js';

const get = async (app: FastifyInstance, url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url, headers });
  const isJson = String(res.headers['content-type']).includes('json');
  return { status: res.statusCode, body: isJson ? res.json() : res.body, headers: res.headers };
};

describe('API', () => {
  const db = fixtureDb();
  const app = buildApp(db, { apiKey: null });
  beforeAll(() => app.ready());
  afterAll(() => app.close());

  describe('reference', () => {
    it('GET /health', async () => {
      expect((await get(app, '/health')).body).toEqual({ status: 'ok', database: 'up' });
    });

    it('GET /meta describes the dataset', async () => {
      const { body } = await get(app, '/api/v1/meta');
      expect(body).toMatchObject({ stations: 5, observations: 9, firstDate: '2026-09-01', lastDate: '2026-09-08' });
      expect(body.states).toEqual([{ state: 'RJ', stations: 3 }, { state: 'SP', stations: 2 }]);
      expect(body.lastIngest).toMatchObject({ source: 'fixture.csv', rowsAccepted: 9 });
    });

    it('GET /products lists products with units', async () => {
      const { body } = await get(app, '/api/v1/products');
      expect(body.data.map((p: { name: string }) => p.name)).toEqual(['ETANOL', 'GASOLINA']);
      expect(body.data[1]).toMatchObject({ unit: 'R$ / litro', observations: 7 });
    });
  });

  describe('prices/summary', () => {
    it('computes min, avg, median (odd count) and max', async () => {
      const { body } = await get(app, '/api/v1/prices/summary?product=GASOLINA');
      expect(body).toMatchObject({ observations: 7, stations: 5, min: 6, avg: 6.686, median: 6.8, max: 7.2 });
    });

    it('computes the median of an even count as the mean of the two middle values', async () => {
      const { body } = await get(app, '/api/v1/prices/summary?product=GASOLINA&state=RJ');
      expect(body).toMatchObject({ observations: 4, stations: 3, avg: 7.025, median: 7.05 });
    });

    it('is case-insensitive for product and state', async () => {
      const { body } = await get(app, '/api/v1/prices/summary?product=gasolina&state=rj');
      expect(body.observations).toBe(4);
    });

    it('filters by date range, brand and city', async () => {
      expect((await get(app, '/api/v1/prices/summary?product=GASOLINA&from=2026-09-05')).body).toMatchObject({ observations: 2, avg: 6.65 });
      expect((await get(app, '/api/v1/prices/summary?product=GASOLINA&brand=BRANCA')).body).toMatchObject({ observations: 3, stations: 2 });
      expect((await get(app, '/api/v1/prices/summary?product=GASOLINA&city=campinas')).body).toMatchObject({ observations: 1, avg: 6.5, median: 6.5 });
    });

    it('returns nulls, not an error, for an empty slice', async () => {
      const { status, body } = await get(app, '/api/v1/prices/summary?product=GASOLINA&state=AC');
      expect(status).toBe(200);
      expect(body).toMatchObject({ observations: 0, stations: 0, min: null, avg: null, median: null, max: null });
    });
  });

  describe('prices/trend', () => {
    it('returns daily averages, moving average and change', async () => {
      const { body } = await get(app, '/api/v1/prices/trend?product=GASOLINA');
      expect(body.data).toEqual([
        { period: '2026-09-01', avg: 6.7, min: 6, max: 7.2, observations: 5, stations: 5, movingAvg7: 6.7, change: null },
        { period: '2026-09-08', avg: 6.65, min: 6.2, max: 7.1, observations: 2, stations: 2, movingAvg7: 6.675, change: -0.05 },
      ]);
    });

    it('groups by week starting on Monday', async () => {
      const { body } = await get(app, '/api/v1/prices/trend?product=GASOLINA&granularity=week');
      expect(body.data.map((d: { period: string }) => d.period)).toEqual(['2026-08-31', '2026-09-07']);
    });
  });

  describe('rankings', () => {
    it('by-state ranks cheapest first with the gap vs the weighted average', async () => {
      const { body } = await get(app, '/api/v1/prices/by-state?product=GASOLINA');
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({ state: 'SP', avg: 6.233, rankCheapest: 1, stations: 2, vsAveragePct: -6.77 });
      expect(body.data[1]).toMatchObject({ state: 'RJ', avg: 7.025, rankCheapest: 2, stations: 3, vsAveragePct: 5.07 });
    });

    it('minStations drops small groups', async () => {
      const { body } = await get(app, '/api/v1/prices/by-state?product=GASOLINA&minStations=3');
      expect(body.data.map((d: { state: string }) => d.state)).toEqual(['RJ']);
    });

    it('by-brand ranks brands', async () => {
      const { body } = await get(app, '/api/v1/prices/by-brand?product=GASOLINA&minStations=1');
      expect(body.data.map((d: { brand: string }) => d.brand)).toEqual(['BRANCA', 'VIBRA', 'IPIRANGA']);
      expect(body.data[0]).toMatchObject({ avg: 6.333, stations: 2 });
    });

    it('by-city requires a state', async () => {
      expect((await get(app, '/api/v1/prices/by-city?product=GASOLINA')).status).toBe(400);
      const { body } = await get(app, '/api/v1/prices/by-city?product=GASOLINA&state=RJ&minStations=1');
      expect(body.data.map((d: { city: string }) => d.city)).toEqual(['RIO DE JANEIRO', 'NITEROI']);
    });
  });

  describe('stations', () => {
    it('cheapest uses each station\'s latest price', async () => {
      const { body } = await get(app, '/api/v1/stations/cheapest?product=GASOLINA');
      expect(body.total).toBe(5);
      expect(body.data.map((s: { cnpj: string; price: number }) => [s.cnpj.slice(0, 2), s.price])).toEqual([
        ['11', 6.2], ['22', 6.5], ['55', 6.8], ['33', 7.1], ['44', 7.2],
      ]);
    });

    it('supports order=desc, limit and offset', async () => {
      const desc = await get(app, '/api/v1/stations/cheapest?product=GASOLINA&order=desc&limit=2');
      expect(desc.body.data.map((s: { cnpj: string }) => s.cnpj)).toEqual([D, C]);
      const page = await get(app, '/api/v1/stations/cheapest?product=GASOLINA&limit=2&offset=2');
      expect(page.body.data.map((s: { price: number }) => s.price)).toEqual([6.8, 7.1]);
      expect(page.body.total).toBe(5);
    });

    it('a date filter changes which observation is "latest"', async () => {
      const { body } = await get(app, '/api/v1/stations/cheapest?product=GASOLINA&to=2026-09-05');
      expect(body.data.find((s: { cnpj: string }) => s.cnpj === A).price).toBe(6);
    });

    it('GET /stations/:cnpj returns the latest price per product', async () => {
      const { status, body } = await get(app, `/api/v1/stations/${A}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ name: 'STATION 111', brand: 'BRANCA', state: 'SP', city: 'SAO PAULO' });
      expect(body.latestPrices).toEqual([
        { product: 'ETANOL', price: 4, collectedOn: '2026-09-01' },
        { product: 'GASOLINA', price: 6.2, collectedOn: '2026-09-08' },
      ]);
    });

    it('GET /stations/:cnpj/prices returns the history', async () => {
      const { body } = await get(app, `/api/v1/stations/${A}/prices`);
      expect(body.data.map((r: { product: string; collectedOn: string }) => `${r.collectedOn} ${r.product}`)).toEqual([
        '2026-09-01 ETANOL', '2026-09-01 GASOLINA', '2026-09-08 GASOLINA',
      ]);
      const filtered = await get(app, `/api/v1/stations/${A}/prices?product=gasolina&from=2026-09-05`);
      expect(filtered.body.data).toHaveLength(1);
    });

    it('404s for an unknown station and 400s for a malformed CNPJ', async () => {
      const missing = await get(app, '/api/v1/stations/99999999999999');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('STATION_NOT_FOUND');
      expect((await get(app, '/api/v1/stations/abc')).status).toBe(400);
      expect((await get(app, '/api/v1/stations/99999999999999/prices')).status).toBe(404);
    });
  });

  describe('insights/ethanol-parity', () => {
    it('compares ethanol with gasoline per state using the 70% rule', async () => {
      const { body } = await get(app, '/api/v1/insights/ethanol-parity');
      expect(body.threshold).toBe(70);
      expect(body.data).toEqual([
        { state: 'RJ', ethanolAvg: 4.5, gasolineAvg: 7.025, ratioPct: 64.1, cheaperPerKm: 'ETANOL', ethanolStations: 1, gasolineStations: 3 },
        { state: 'SP', ethanolAvg: 4, gasolineAvg: 6.233, ratioPct: 64.2, cheaperPerKm: 'ETANOL', ethanolStations: 1, gasolineStations: 2 },
      ]);
    });

    it('recommends gasoline when ethanol is above 70% of it', async () => {
      const mg = [
        { cnpj: '66666666000166', brand: 'VIBRA', state: 'MG', city: 'BH', product: 'GASOLINA', date: '01/09/2026', price: '6,00' },
        { cnpj: '66666666000166', brand: 'VIBRA', state: 'MG', city: 'BH', product: 'ETANOL', date: '01/09/2026', price: '5,00' },
      ];
      const other = buildApp(fixtureDb([...FIXTURE_ROWS, ...mg]), { apiKey: null });
      const { body } = await get(other, '/api/v1/insights/ethanol-parity?state=mg');
      expect(body.data).toEqual([expect.objectContaining({ state: 'MG', ratioPct: 83.3, cheaperPerKm: 'GASOLINA' })]);
      await other.close();
    });

    it('respects the date filter and skips states missing a product', async () => {
      const { body } = await get(app, '/api/v1/insights/ethanol-parity?from=2026-09-05');
      expect(body.data).toEqual([]); // ethanol was only observed on 09-01
    });
  });

  describe('export', () => {
    it('state-daily as JSON', async () => {
      const { body } = await get(app, '/api/v1/export/state-daily?product=GASOLINA');
      expect(body.count).toBe(4); // (09-01: SP, RJ) + (09-08: SP, RJ)
      expect(body.data[0]).toEqual({ date: '2026-09-01', state: 'RJ', product: 'GASOLINA', avg: 7, min: 6.8, max: 7.2, observations: 3, stations: 3 });
    });

    it('state-daily as CSV', async () => {
      const res = await get(app, '/api/v1/export/state-daily?product=GASOLINA&format=csv');
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('state-daily.csv');
      const [header, first] = (res.body as string).split('\r\n');
      expect(header).toBe('date,state,product,avg,min,max,observations,stations');
      expect(first).toBe('2026-09-01,RJ,GASOLINA,7,6.8,7.2,3,3');
    });

    it('stations dimension as CSV, filtered', async () => {
      const res = await get(app, '/api/v1/export/stations?state=SP&format=csv');
      const lines = (res.body as string).trim().split('\r\n');
      expect(lines[0]).toBe('cnpj,name,brand,region,state,city,neighborhood,zip');
      expect(lines).toHaveLength(3);
    });
  });

  describe('errors', () => {
    it('validation errors are 400 with field details', async () => {
      const { status, body } = await get(app, '/api/v1/prices/summary');
      expect(status).toBe(400);
      expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'product' }] });
    });

    it.each([
      ['inverted range', '/api/v1/prices/summary?product=GASOLINA&from=2026-09-10&to=2026-09-01'],
      ['impossible date', '/api/v1/prices/summary?product=GASOLINA&from=2026-02-31'],
      ['bad granularity', '/api/v1/prices/trend?product=GASOLINA&granularity=year'],
      ['limit too big', '/api/v1/stations/cheapest?product=GASOLINA&limit=1000'],
      ['negative offset', '/api/v1/stations/cheapest?product=GASOLINA&offset=-1'],
      ['bad state', '/api/v1/prices/summary?product=GASOLINA&state=RJX'],
    ])('rejects %s', async (_name, url) => {
      expect((await get(app, url)).status).toBe(400);
    });

    it('unknown product lists the valid ones', async () => {
      const { status, body } = await get(app, '/api/v1/prices/summary?product=BANANA');
      expect(status).toBe(400);
      expect(body.error).toMatchObject({ code: 'UNKNOWN_PRODUCT', details: { validProducts: ['ETANOL', 'GASOLINA'] } });
    });

    it('treats SQL in parameters as plain values', async () => {
      const injection = encodeURIComponent("GASOLINA' OR '1'='1");
      expect((await get(app, `/api/v1/prices/summary?product=${injection}`)).body.error.code).toBe('UNKNOWN_PRODUCT');
      const city = await get(app, `/api/v1/prices/summary?product=GASOLINA&city=${encodeURIComponent("X' OR 1=1 --")}`);
      expect(city.body.observations).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM prices').get()).toEqual({ n: 9 });
    });

    it('unknown routes return a JSON 404', async () => {
      const { status, body } = await get(app, '/api/v1/nope');
      expect(status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  it('sends cache headers on API responses', async () => {
    expect((await get(app, '/api/v1/meta')).headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('API key', () => {
  const secured = buildApp(fixtureDb(), { apiKey: 's3cret' });
  afterAll(() => secured.close());

  it('rejects requests without or with a wrong key', async () => {
    expect((await get(secured, '/api/v1/meta')).status).toBe(401);
    const wrong = await get(secured, '/api/v1/meta', { 'x-api-key': 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts the right key', async () => {
    expect((await get(secured, '/api/v1/meta', { 'x-api-key': 's3cret' })).status).toBe(200);
  });

  it('keeps /health public', async () => {
    expect((await get(secured, '/health')).status).toBe(200);
  });
});

describe('OpenAPI spec', () => {
  it('documents exactly the routes the server registers', async () => {
    const app = buildApp(fixtureDb(), { apiKey: null });
    await app.ready();
    const registered = app.routeList
      .map((r) => r.url.replace(/:(\w+)/g, '{$1}'))
      .filter((url) => !['/openapi.json', '/docs'].includes(url))
      .sort();
    const documented = Object.keys(openapi.paths).sort();
    expect(registered).toEqual(documented);
    await app.close();
  });

  it('every $ref points at something that exists', () => {
    const refs = Array.from(JSON.stringify(openapi).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g), (m) => [m[1]!, m[2]!] as const);
    expect(refs.length).toBeGreaterThan(10);
    for (const [section, name] of refs) {
      expect(Object.keys(openapi.components[section as keyof typeof openapi.components]), `${section}/${name}`).toContain(name);
    }
  });
});
