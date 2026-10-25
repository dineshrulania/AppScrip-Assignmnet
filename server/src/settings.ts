import type { Ctx } from './context.js';

/**
 * Runtime switches stored in the DB so they apply across processes. Used for
 * fault injection from the dashboard ("chaos controls") during demos and tests.
 */
export interface Chaos {
  /** 0..1 probability that processing an event throws (exercises retry + dead-letter). */
  processingFailureRate: number;
  /** Stops the worker claiming events, simulating ingestion outpacing processing. */
  workerPaused: boolean;
  /** Artificial per-event processing delay in ms (simulates a slow consumer). */
  processingDelayMs: number;
}

const DEFAULTS: Chaos = { processingFailureRate: 0, workerPaused: false, processingDelayMs: 0 };

export function getChaos(ctx: Ctx): Chaos {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'chaos'").get() as
    | { value: string }
    | undefined;
  return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}

export function setChaos(ctx: Ctx, patch: Partial<Chaos>): Chaos {
  const next = { ...getChaos(ctx), ...patch };
  next.processingFailureRate = Math.min(1, Math.max(0, Number(next.processingFailureRate) || 0));
  next.processingDelayMs = Math.min(5000, Math.max(0, Number(next.processingDelayMs) || 0));
  next.workerPaused = Boolean(next.workerPaused);
  ctx.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('chaos', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(JSON.stringify(next));
  return next;
}

export function heartbeat(ctx: Ctx, component: string, startedAt: number, info: object = {}) {
  ctx.db
    .prepare(
      `INSERT INTO heartbeats (component, pid, started_at, beat_at, info) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(component) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at,
         beat_at = excluded.beat_at, info = excluded.info`,
    )
    .run(component, process.pid, startedAt, ctx.now(), JSON.stringify(info));
}
