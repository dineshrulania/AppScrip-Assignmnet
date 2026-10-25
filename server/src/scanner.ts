import type { Ctx } from './context.js';
import { tx } from './db.js';
import { publish, pruneChanges } from './changes.js';
import { enabledRules, inScope } from './rules.js';
import { trigger } from './incidents.js';
import { deviceRow, logDevice } from './ingest.js';

/**
 * Time-based checks that no incoming event can trigger: "device went offline" and
 * "device has not reported for N seconds" (absence rules).
 *
 * Silence is measured with the SERVER clock against `last_seen_at`, which ingestion updates
 * on every authenticated request. Device clocks may drift; a backlog in the worker does not
 * delay `last_seen_at`; so neither can cause a false "stopped reporting" alert.
 */
export class Scanner {
  private startedAt: number;
  lastRunAt = 0;

  constructor(private ctx: Ctx) {
    this.startedAt = ctx.now();
  }

  /**
   * If the ingestion API itself was down, devices could not report - their silence says nothing
   * about the devices. We only count silence from the moment ingestion was available (and this
   * scanner was running), which avoids an alert storm after a platform outage or restart.
   */
  private ingestAvailableSince(): number | null {
    const now = this.ctx.now();
    const api = this.ctx.db.prepare("SELECT started_at, beat_at FROM heartbeats WHERE component = 'api'").get() as
      | { started_at: number; beat_at: number }
      | undefined;
    if (!api || now - api.beat_at > 15_000) return null; // API down: can't tell device silence from our outage
    return Math.max(this.startedAt, api.started_at);
  }

  run() {
    const { ctx } = this;
    const now = ctx.now();
    this.lastRunAt = now;

    // 1. online -> offline transitions (purely informational device status).
    const stale = ctx.db
      .prepare(`SELECT id FROM devices WHERE status = 'online' AND last_seen_at < ?`)
      .all(now - ctx.config.scanner.offlineAfterMs) as { id: string }[];
    if (stale.length) {
      tx(ctx.db, () => {
        for (const { id } of stale) {
          ctx.db.prepare(`UPDATE devices SET status = 'offline', status_since = ? WHERE id = ?`).run(now, id);
          logDevice(ctx, id, 'offline', `No traffic for ${ctx.config.scanner.offlineAfterMs / 1000}s`);
          publish(ctx, 'device', deviceRow(ctx, id));
        }
      });
      ctx.log.warn({ devices: stale.map((d) => d.id) }, `${stale.length} device(s) went offline`);
    }

    // 2. absence rules.
    const absenceRules = enabledRules(ctx).filter((r) => r.kind === 'absence');
    if (absenceRules.length) {
      const since = this.ingestAvailableSince();
      if (since === null) {
        ctx.log.warn('absence rules paused: ingestion API heartbeat is stale');
      } else {
        for (const rule of absenceRules) {
          const windowMs = (rule.config as { duration_sec: number }).duration_sec * 1000;
          // Devices silent for longer than the window, that don't already have an open incident for this rule.
          const candidates = ctx.db
            .prepare(
              `SELECT d.id, d.name, d.type, d.location, d.last_seen_at, d.created_at FROM devices d
               WHERE MAX(COALESCE(d.last_seen_at, d.created_at), ?) < ?
                 AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.dedup_key = ? || ':' || d.id AND i.status != 'resolved')`,
            )
            .all(since, now - windowMs, rule.id) as any[];
          for (const d of candidates) {
            if (inScope(rule, d)) continue;
            const silentFor = Math.round((now - (d.last_seen_at ?? d.created_at)) / 1000);
            const reason = d.last_seen_at
              ? `no data for ${silentFor}s (limit ${windowMs / 1000}s); last seen ${new Date(d.last_seen_at).toISOString()}`
              : `never reported since registration ${silentFor}s ago`;
            tx(ctx.db, () => {
              const t = trigger(ctx, rule, d, reason, null);
              ctx.db
                .prepare('INSERT INTO rule_evaluations (event_pk, rule_id, device_id, at, outcome, reason, incident_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)')
                .run(rule.id, d.id, now, t.kind === 'created' ? 'matched' : t.kind, `${reason} — incident #${t.incidentId}`, t.incidentId);
            });
          }
        }
      }
    }
  }

  /** Housekeeping that should not run every tick. */
  prune() {
    const { ctx } = this;
    const removed = pruneChanges(ctx);
    ctx.db.prepare('DELETE FROM ingest_stats WHERE bucket < ?').run(Math.floor((ctx.now() - 24 * 3600_000) / 1000));
    ctx.db.prepare('DELETE FROM rule_evaluations WHERE at < ?').run(ctx.now() - 24 * 3600_000);
    if (removed) ctx.log.debug({ removed }, 'pruned change feed');
  }
}
