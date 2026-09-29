import { z } from 'zod';

const upper = z.string().trim().min(1).max(60).transform((s) => s.toUpperCase());
const state = z.string().trim().length(2).transform((s) => s.toUpperCase());
const date = z.iso.date();
const rangeOk = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const rangeIssue = { message: '`from` must not be after `to`', path: ['from'] };

const filters = {
  state: state.optional(),
  city: upper.optional(),
  brand: upper.optional(),
  from: date.optional(),
  to: date.optional(),
};

const minStations = (fallback: number) => z.coerce.number().int().min(1).max(10_000).default(fallback);
const format = z.enum(['json', 'csv']).default('json');

export const summaryQuery = z.object({ product: upper, ...filters }).refine(rangeOk, rangeIssue);

export const trendQuery = z
  .object({ product: upper, ...filters, granularity: z.enum(['day', 'week']).default('day') })
  .refine(rangeOk, rangeIssue);

export const byStateQuery = z
  .object({ product: upper, city: filters.city, brand: filters.brand, from: filters.from, to: filters.to, minStations: minStations(1) })
  .refine(rangeOk, rangeIssue);

export const byBrandQuery = z
  .object({ product: upper, state: filters.state, city: filters.city, from: filters.from, to: filters.to, minStations: minStations(3) })
  .refine(rangeOk, rangeIssue);

export const byCityQuery = z
  .object({ product: upper, state, brand: filters.brand, from: filters.from, to: filters.to, minStations: minStations(3) })
  .refine(rangeOk, rangeIssue);

export const cheapestQuery = z
  .object({
    product: upper,
    ...filters,
    order: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(rangeOk, rangeIssue);

export const cnpjParams = z.object({ cnpj: z.string().regex(/^\d{14}$/, 'CNPJ must have 14 digits (numbers only)') });

export const stationPricesQuery = z
  .object({ product: upper.optional(), from: filters.from, to: filters.to })
  .refine(rangeOk, rangeIssue);

export const stateDailyQuery = z
  .object({ product: upper.optional(), from: filters.from, to: filters.to, format })
  .refine(rangeOk, rangeIssue);

export const stationsExportQuery = z.object({ state: filters.state, brand: filters.brand, format });

export const parityQuery = z.object({ state: filters.state, from: filters.from, to: filters.to }).refine(rangeOk, rangeIssue);
