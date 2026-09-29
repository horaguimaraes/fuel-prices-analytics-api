export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** When set, every /api request must send it in the `x-api-key` header. */
  apiKey: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/fuel.db',
    apiKey: env.API_KEY?.trim() || null,
  };
}
