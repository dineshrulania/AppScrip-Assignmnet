import pino, { type Logger } from 'pino';
import { config as defaultConfig, type Config } from './config.js';
import { openDb, type DB } from './db.js';

/** Everything a component needs. Tests build one with an in-memory DB and a fake clock. */
export interface Ctx {
  db: DB;
  log: Logger;
  config: Config;
  now: () => number;
}

export function createLogger(level = defaultConfig.logLevel, component?: string): Logger {
  const pretty = process.stdout.isTTY && process.env.LOG_FORMAT !== 'json';
  return pino({
    level,
    base: component ? { component } : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: pretty
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined,
  });
}

export function createCtx(overrides: Partial<Ctx> & { component?: string } = {}): Ctx {
  const config = overrides.config ?? defaultConfig;
  return {
    config,
    db: overrides.db ?? openDb(config.dbPath),
    log: overrides.log ?? createLogger(config.logLevel, overrides.component),
    now: overrides.now ?? Date.now,
  };
}
