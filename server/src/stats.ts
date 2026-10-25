import type { Ctx } from './context.js';
import { json } from './db.js';
import { getChaos } from './settings.js';
import { queueDepth } from './ingest.js';

const one = <T = any>(ctx: Ctx, sql: string, ...params: unknown[]) => ctx.db.prepare(sql).get(...params) as T;

export function overview(ctx: Ctx) {
  const now = ctx.now();
  const devices = one(ctx, `SELECT COUNT(*) total, SUM(status = 'online') online, SUM(status = 'offline') offline FROM devices`);
  const lastMin = one(ctx, `SELECT COALESCE(SUM(accepted),0) accepted, COALESCE(SUM(duplicates),0) duplicates,
                                  COALESCE(SUM(rejected),0) rejected, COALESCE(SUM(late),0) late
                           FROM ingest_stats WHERE bucket >= ?`, Math.floor((now - 60_000) / 1000));
  const totals = one(ctx, `SELECT COALESCE(SUM(accepted),0) accepted, COALESCE(SUM(duplicates),0) duplicates,
                                 COALESCE(SUM(rejected),0) rejected, COALESCE(SUM(late),0) late FROM ingest_stats`);
  const queue = one(ctx, `SELECT SUM(status = 'pending') pending, SUM(status = 'processing') processing,
                                SUM(status = 'failed') failed, MIN(CASE WHEN status IN ('pending','processing') THEN received_at END) oldest
                         FROM events`);
  const lags = (ctx.db.prepare('SELECT processed_at - received_at AS lag FROM events WHERE processed_at > ? ORDER BY lag').all(now - 60_000) as { lag: number }[]).map((r) => r.lag);
  const pct = (p: number) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] : 0);
  const incidents = ctx.db.prepare(`SELECT status, severity, COUNT(*) n FROM incidents GROUP BY status, severity`).all() as any[];
  const byStatus = { open: 0, acknowledged: 0, resolved: 0 };
  const activeBySeverity = { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>;
  for (const r of incidents) {
    byStatus[r.status as keyof typeof byStatus] += r.n;
    if (r.status !== 'resolved') activeBySeverity[r.severity] += r.n;
  }
  const notif = one(ctx, `SELECT SUM(status='pending') pending, SUM(status='sent') sent, SUM(status='dead') dead FROM notifications`);
  const mttaRow = one(ctx, `SELECT AVG(acknowledged_at - opened_at) v FROM incidents WHERE acknowledged_at IS NOT NULL AND opened_at > ?`, now - 24 * 3600_000);

  return {
    at: now,
    devices: { total: devices.total ?? 0, online: devices.online ?? 0, offline: devices.offline ?? 0 },
    events_last_min: lastMin,
    events_total: totals,
    queue: {
      depth: queueDepth(ctx, 0),
      pending: queue.pending ?? 0,
      processing: queue.processing ?? 0,
      dead_letter: queue.failed ?? 0,
      oldest_age_ms: queue.oldest ? now - queue.oldest : 0,
      high_watermark: ctx.config.ingest.highWatermark,
    },
    processing_lag_ms: { p50: pct(0.5), p95: pct(0.95), max: lags.at(-1) ?? 0, samples: lags.length },
    incidents: { ...byStatus, active_by_severity: activeBySeverity, mtta_ms: mttaRow.v ? Math.round(mttaRow.v) : null },
    notifications: { pending: notif.pending ?? 0, sent: notif.sent ?? 0, dead: notif.dead ?? 0 },
  };
}

/** Ingest throughput in fixed buckets for the dashboard chart. */
export function timeseries(ctx: Ctx, minutes = 15, bucketSec = 10) {
  const nowSec = Math.floor(ctx.now() / 1000);
  const start = nowSec - minutes * 60;
  const rows = ctx.db
    .prepare(`SELECT (bucket / ?) * ? AS b, SUM(accepted) accepted, SUM(duplicates) duplicates, SUM(rejected) rejected, SUM(late) late
              FROM ingest_stats WHERE bucket >= ? GROUP BY b ORDER BY b`)
    .all(bucketSec, bucketSec, start) as any[];
  const byBucket = new Map(rows.map((r) => [r.b, r]));
  const out = [];
  for (let b = Math.floor(start / bucketSec) * bucketSec; b <= nowSec; b += bucketSec) {
    const r = byBucket.get(b);
    out.push({ t: b * 1000, accepted: r?.accepted ?? 0, duplicates: r?.duplicates ?? 0, rejected: r?.rejected ?? 0, late: r?.late ?? 0 });
  }
  return { bucket_sec: bucketSec, points: out };
}

export function systemHealth(ctx: Ctx) {
  const now = ctx.now();
  const beats = (ctx.db.prepare('SELECT * FROM heartbeats').all() as any[]).map((b) => ({
    component: b.component,
    pid: b.pid,
    started_at: b.started_at,
    beat_at: b.beat_at,
    age_ms: now - b.beat_at,
    healthy: now - b.beat_at < 10_000,
    info: json(b.info, {}),
  }));
  const deadLetters = ctx.db
    .prepare(`SELECT id, device_id, event_id, type, ts, received_at, attempts, last_error FROM events WHERE status = 'failed' ORDER BY id DESC LIMIT 50`)
    .all();
  const rejected = ctx.db.prepare('SELECT * FROM rejected_events ORDER BY id DESC LIMIT 50').all();
  const deadNotifications = ctx.db
    .prepare(`SELECT id, incident_id, operator_id, attempts, last_error, created_at FROM notifications WHERE status != 'sent' ORDER BY id DESC LIMIT 50`)
    .all();
  return { components: beats, chaos: getChaos(ctx), dead_letters: deadLetters, rejected, undelivered_notifications: deadNotifications };
}

/** Prometheus text exposition. */
export function prometheus(ctx: Ctx) {
  const o = overview(ctx);
  const lines: string[] = [];
  const g = (name: string, help: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
  };
  g('netwatch_devices_online', 'Devices currently online', o.devices.online);
  g('netwatch_devices_offline', 'Devices currently offline', o.devices.offline);
  g('netwatch_events_accepted_total', 'Events accepted (24h window)', o.events_total.accepted);
  g('netwatch_events_duplicate_total', 'Duplicate events ignored (24h window)', o.events_total.duplicates);
  g('netwatch_events_rejected_total', 'Malformed events rejected (24h window)', o.events_total.rejected);
  g('netwatch_queue_depth', 'Events waiting to be processed', o.queue.depth);
  g('netwatch_queue_oldest_age_seconds', 'Age of the oldest unprocessed event', o.queue.oldest_age_ms / 1000);
  g('netwatch_dead_letter_events', 'Events that exhausted retries', o.queue.dead_letter);
  g('netwatch_processing_lag_p95_seconds', 'p95 ingest-to-processed latency (1m)', o.processing_lag_ms.p95 / 1000);
  g('netwatch_incidents_open', 'Open incidents', o.incidents.open);
  g('netwatch_incidents_acknowledged', 'Acknowledged incidents', o.incidents.acknowledged);
  g('netwatch_notifications_pending', 'Notifications waiting for delivery', o.notifications.pending);
  g('netwatch_notifications_dead', 'Notifications that exhausted retries', o.notifications.dead);
  return lines.join('\n') + '\n';
}
