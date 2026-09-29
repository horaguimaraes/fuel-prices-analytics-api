import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureDb } from './fixtures.js';

const file = readFileSync(new URL('../sql/analytics-examples.sql', import.meta.url), 'utf8');
const examples = file
  .split(/^-- name: /m)
  .slice(1)
  .map((block) => {
    const [title, ...rest] = block.split('\n');
    return { title: title!.trim(), sql: rest.join('\n').trim() };
  });

describe('sql/analytics-examples.sql', () => {
  it('contains the documented examples', () => {
    expect(examples.length).toBeGreaterThanOrEqual(6);
  });

  it.each(examples.map((e) => [e.title, e.sql] as const))('runs: %s', (_title, sql) => {
    const db = fixtureDb();
    expect(() => db.prepare(sql).all()).not.toThrow();
  });

  it('week-over-week returns the change per state', () => {
    const db = fixtureDb();
    const rows = db.prepare(examples[0]!.sql).all() as { state: string; week: string; change_vs_prev_week: number | null }[];
    const sp = rows.filter((r) => r.state === 'SP');
    expect(sp.map((r) => r.week)).toEqual(['2026-08-31', '2026-09-07']);
    expect(sp[0]!.change_vs_prev_week).toBeNull();
    expect(sp[1]!.change_vs_prev_week).toBeCloseTo(-0.05, 3); // (6.0+6.5)/2=6.25 -> 6.2
  });
});
