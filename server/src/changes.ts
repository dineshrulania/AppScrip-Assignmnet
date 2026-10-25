import type { Ctx } from './context.js';

/**
 * Append-only change feed. Any process (api, worker, scanner, notifier) records what
 * changed; the API process tails the table and fans changes out to dashboards over SSE.
 * Because ids are durable and monotonic, a dashboard that reconnects with
 * `Last-Event-ID: 1234` receives exactly the changes it missed.
 */
export type Topic =
  | 'event'
  | 'event.processed'
  | 'device'
  | 'incident'
  | 'notification'
  | 'rule'
  | 'system';

export function publish(ctx: Ctx, topic: Topic, data: unknown) {
  ctx.db
    .prepare('INSERT INTO changes (at, topic, data) VALUES (?, ?, ?)')
    .run(ctx.now(), topic, JSON.stringify(data));
}

export function changesSince(ctx: Ctx, afterId: number, limit = 1000) {
  return ctx.db
    .prepare('SELECT id, topic, data FROM changes WHERE id > ? ORDER BY id LIMIT ?')
    .all(afterId, limit) as { id: number; topic: Topic; data: string }[];
}

export function oldestChangeId(ctx: Ctx): number {
  const row = ctx.db.prepare('SELECT MIN(id) AS id FROM changes').get() as { id: number | null };
  return row.id ?? 0;
}

export function latestChangeId(ctx: Ctx): number {
  const row = ctx.db.prepare('SELECT MAX(id) AS id FROM changes').get() as { id: number | null };
  return row.id ?? 0;
}

export function pruneChanges(ctx: Ctx) {
  return ctx.db
    .prepare('DELETE FROM changes WHERE at < ?')
    .run(ctx.now() - ctx.config.changes.retentionMs).changes;
}
