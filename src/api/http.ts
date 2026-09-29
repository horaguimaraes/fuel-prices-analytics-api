import type { z } from 'zod';

/** An error that maps directly to an HTTP response: `{ "error": { code, message, details? } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    'VALIDATION_ERROR',
    'Invalid request parameters',
    result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }))
  );
}

/** RFC 4180 CSV. String cells starting with = + - @ get a leading quote (spreadsheet formula injection). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]!);
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => cell(row[h])).join(','))].join('\r\n') + '\r\n';
}
