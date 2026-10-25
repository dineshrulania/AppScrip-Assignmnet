import pino from 'pino';
import { config as baseConfig, type Config } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { Ctx } from '../src/context.js';
import { seed } from '../src/seed.js';
import { ingest, registerDevice } from '../src/ingest.js';
import { Processor } from '../src/worker.js';
import { heartbeat } from '../src/settings.js';

export const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);

export interface TestCtx extends Ctx {
  clock: { t: number };
  advance: (ms: number) => void;
}

/** In-memory DB, seeded rules/operators, a controllable clock and a silent logger. */
export function makeCtx(overrides: (c: Config) => void = () => {}): TestCtx {
  const config: Config = structuredClone(baseConfig);
  config.dbPath = ':memory:';
  overrides(config);
  const clock = { t: T0 };
  const ctx: TestCtx = {
    db: openDb(':memory:'),
    log: pino({ level: 'silent' }),
    config,
    now: () => clock.t,
    clock,
    advance: (ms) => void (clock.t += ms),
  };
  seed(ctx);
  return ctx;
}

export const DEVICES = {
  cold: { device_id: 'cs-1', name: 'Cold Room', location: 'North Warehouse', type: 'cold_storage' },
  hvac: { device_id: 'hvac-1', name: 'CRAC', location: 'Central DC', type: 'hvac' },
};

export function addDevice(ctx: Ctx, d = DEVICES.cold) {
  return registerDevice(ctx, d);
}

let n = 0;
export const tele = (ts: number, payload: Record<string, unknown>, id = `e${++n}`, seq?: number) => ({
  event_id: id,
  seq,
  type: 'telemetry',
  ts,
  payload,
});

export const send = (ctx: Ctx, deviceId: string, events: unknown[]) => ingest(ctx, deviceId, { events });

/** Process until the queue is empty (or `max` rounds). */
export async function drain(ctx: Ctx, p = new Processor(ctx), max = 20) {
  for (let i = 0; i < max; i++) if ((await p.tick()) === 0) break;
  return p;
}

export const apiAlive = (ctx: Ctx, startedAt = ctx.now()) => heartbeat(ctx, 'api', startedAt);

export const rows = <T = any>(ctx: Ctx, sql: string, ...params: unknown[]) => ctx.db.prepare(sql).all(...params) as T[];
export const row = <T = any>(ctx: Ctx, sql: string, ...params: unknown[]) => ctx.db.prepare(sql).get(...params) as T;
