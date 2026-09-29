import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/connection.js';
import openapi from './openapi.json' with { type: 'json' };
import { HttpError, parse, toCsv } from './http.js';
import * as q from './queries.js';
import * as s from './schemas.js';

export interface RouteInfo { method: string; url: string }
declare module 'fastify' {
  interface FastifyInstance { routeList: RouteInfo[] }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fuel Prices API</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`;

export function buildApp(db: Db, config: Pick<Config, 'apiKey'>): FastifyInstance {
  const app = Fastify({ logger: false });

  const routeList: RouteInfo[] = [];
  app.decorate('routeList', routeList);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) if (method === 'GET') routeList.push({ method, url: route.url });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (error as Error).message } });
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url.split('?')[0]} not found` } })
  );

  app.get('/health', async () => ({ status: 'ok', database: db.prepare('SELECT 1 AS ok').get() ? 'up' : 'down' }));
  app.get('/openapi.json', async () => openapi);
  app.get('/docs', async (_request, reply) => reply.type('text/html; charset=utf-8').send(DOCS_HTML));

  app.register(
    async (api) => {
      if (config.apiKey) {
        const expected = digest(config.apiKey);
        api.addHook('onRequest', async (request) => {
          const supplied = request.headers['x-api-key'];
          const ok = typeof supplied === 'string' && timingSafeEqual(digest(supplied), expected);
          if (!ok) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid x-api-key header');
        });
      }
      api.addHook('onSend', async (_request, reply) => {
        reply.header('Cache-Control', 'public, max-age=60');
      });

      const knownProduct = (name: string) => {
        if (!q.productExists(db, name)) {
          throw new HttpError(400, 'UNKNOWN_PRODUCT', `Unknown product "${name}"`, { validProducts: q.listProducts(db).map((p) => p.name) });
        }
      };
      const send = (reply: FastifyReply, rows: Record<string, unknown>[], format: 'json' | 'csv', filename: string) => {
        if (format === 'csv') {
          return reply
            .type('text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}.csv"`)
            .send(toCsv(rows));
        }
        return { data: rows, count: rows.length };
      };

      api.get('/meta', async () => q.meta(db));
      api.get('/products', async () => ({ data: q.listProducts(db) }));

      api.get('/prices/summary', async (request) => {
        const { product, ...rest } = parse(s.summaryQuery, request.query);
        knownProduct(product);
        return { product, filters: rest, ...q.summary(db, { product, ...rest }) };
      });

      api.get('/prices/trend', async (request) => {
        const { granularity, product, ...rest } = parse(s.trendQuery, request.query);
        knownProduct(product);
        return { product, granularity, data: q.trend(db, { product, ...rest }, granularity) };
      });

      api.get('/prices/by-state', async (request) => {
        const { minStations, product, ...rest } = parse(s.byStateQuery, request.query);
        knownProduct(product);
        return { product, data: q.ranking(db, { product, ...rest }, 'state', minStations) };
      });

      api.get('/prices/by-brand', async (request) => {
        const { minStations, product, ...rest } = parse(s.byBrandQuery, request.query);
        knownProduct(product);
        return { product, data: q.ranking(db, { product, ...rest }, 'brand', minStations) };
      });

      api.get('/prices/by-city', async (request) => {
        const { minStations, product, ...rest } = parse(s.byCityQuery, request.query);
        knownProduct(product);
        return { product, data: q.ranking(db, { product, ...rest }, 'city', minStations) };
      });

      api.get('/stations/cheapest', async (request) => {
        const { order, limit, offset, product, ...rest } = parse(s.cheapestQuery, request.query);
        knownProduct(product);
        const { total, items } = q.stationsByPrice(db, { product, ...rest }, order, limit, offset);
        return { product, order, total, limit, offset, data: items };
      });

      api.get('/stations/:cnpj', async (request) => {
        const { cnpj } = parse(s.cnpjParams, request.params);
        const station = q.stationDetail(db, cnpj);
        if (!station) throw new HttpError(404, 'STATION_NOT_FOUND', `No station with CNPJ ${cnpj}`);
        return station;
      });

      api.get('/stations/:cnpj/prices', async (request) => {
        const { cnpj } = parse(s.cnpjParams, request.params);
        const filters = parse(s.stationPricesQuery, request.query);
        if (!q.stationDetail(db, cnpj)) throw new HttpError(404, 'STATION_NOT_FOUND', `No station with CNPJ ${cnpj}`);
        if (filters.product) knownProduct(filters.product);
        return { cnpj, data: q.stationPrices(db, cnpj, filters) };
      });

      api.get('/insights/ethanol-parity', async (request) => {
        const filters = parse(s.parityQuery, request.query);
        return { threshold: q.ETHANOL_PARITY * 100, data: q.ethanolParity(db, filters) };
      });

      api.get('/export/state-daily', async (request, reply) => {
        const { format, ...filters } = parse(s.stateDailyQuery, request.query);
        if (filters.product) knownProduct(filters.product);
        return send(reply, q.stateDaily(db, filters), format, 'state-daily');
      });

      api.get('/export/stations', async (request, reply) => {
        const { format, ...filters } = parse(s.stationsExportQuery, request.query);
        return send(reply, q.stationDimension(db, filters), format, 'stations');
      });
    },
    { prefix: '/api/v1' }
  );

  return app;
}
