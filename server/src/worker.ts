import crypto from 'node:crypto';
import type { Ctx } from './context.js';
import { json, tx } from './db.js';
import { publish } from './changes.js';
import { getChaos } from './settings.js';
import { enabledRules, evaluate } from './rules.js';
import { conditionCleared, trigger } from './incidents.js';
import { deviceRow } from './ingest.js';

export interface ClaimedEvent {
  id: number;
  device_id: string;
  event_id: string;
  seq: number | null;
  type: string;
  ts: number;
  received_at: number;
  payload: string;
  late: number;
  out_of_order: number;
  attempts: number;
}

class LeaseLost extends Error {}

/**
 * Event processor.
 *
 * Guarantees:
 *  - At-least-once processing: events are claimed with a lease; if this process dies, the lease
 *    expires and another worker (or this one after restart) picks the event up again.
 *  - Effectively-once side effects: all effects of one event (device state, rule evaluations,
 *    incident changes, outbox rows, status=processed) commit in ONE SQLite transaction. A crash
 *    mid-way rolls everything back; a retry re-applies from scratch.
 *  - Bounded retries: failures back off exponentially; after `maxAttempts` the event is parked
 *    as `failed` (dead-letter) and visible in the dashboard, where an operator can re-queue it.
 */
export class Processor {
  readonly owner = `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  processedTotal = 0;
  failedTotal = 0;

  constructor(private ctx: Ctx) {}

  claim(limit = this.ctx.config.worker.batchSize): ClaimedEvent[] {
    const now = this.ctx.now();
    const rows = this.ctx.db
      .prepare(
        `UPDATE events SET status = 'processing', lease_owner = @owner, lease_until = @lease, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM events
           WHERE (status = 'pending' AND next_attempt_at <= @now)
              OR (status = 'processing' AND lease_until < @now)   -- reclaim from a crashed worker
           ORDER BY id LIMIT @limit)
         RETURNING id, device_id, event_id, seq, type, ts, received_at, payload, late, out_of_order, attempts`,
      )
      .all({ owner: this.owner, lease: now + this.ctx.config.worker.leaseMs, now, limit }) as ClaimedEvent[];
    // Apply each device's events in device-time order, even if they arrived shuffled.
    return rows.sort((a, b) => (a.device_id === b.device_id ? a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0) : a.device_id < b.device_id ? -1 : 1));
  }

  /** Process one claimed event atomically. Throws on failure (caller schedules the retry). */
  processOne(ev: ClaimedEvent) {
    const { ctx } = this;
    const chaos = getChaos(ctx);
    if (chaos.processingFailureRate > 0 && Math.random() < chaos.processingFailureRate)
      throw new Error('injected processing failure (chaos)');

    tx(ctx.db, () => {
      const now = ctx.now();
      // Fencing: only the current lease holder may commit. Protects against a slow worker whose
      // lease expired and was taken over - its late commit is discarded instead of applied twice.
      const fenced = ctx.db
        .prepare(`UPDATE events SET status = 'processed', processed_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL
                  WHERE id = ? AND lease_owner = ? AND status = 'processing'`)
        .run(now, ev.id, this.owner);
      if (fenced.changes === 0) throw new LeaseLost(`lease on event ${ev.id} lost`);

      const device = ctx.db.prepare('SELECT id, name, type, location, last_event_ts, latest FROM devices WHERE id = ?').get(ev.device_id) as any;
      const payload = json<Record<string, unknown>>(ev.payload, {});

      // Device state: only move "latest" forward in device time. A replayed old reading never
      // overwrites a newer one (out-of-order safety).
      if (ev.type === 'telemetry') {
        const latest = json<Record<string, { v: number; ts: number }>>(device.latest, {});
        let changed = false;
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === 'number' && (!latest[k] || latest[k].ts <= ev.ts)) {
            latest[k] = { v, ts: ev.ts };
            changed = true;
          }
        }
        if (changed) ctx.db.prepare('UPDATE devices SET latest = ? WHERE id = ?').run(JSON.stringify(latest), ev.device_id);
      }
      ctx.db
        .prepare('UPDATE devices SET last_event_ts = MAX(COALESCE(last_event_ts, 0), ?), last_seq = CASE WHEN ? >= COALESCE(last_event_ts, 0) THEN COALESCE(?, last_seq) ELSE last_seq END WHERE id = ?')
        .run(ev.ts, ev.ts, ev.seq, ev.device_id);

      // Rule evaluation + decision log.
      const logEval = ctx.db.prepare(
        'INSERT INTO rule_evaluations (event_pk, rule_id, device_id, at, outcome, reason, incident_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const outcomes: { rule_id: number; outcome: string; incident_id?: number }[] = [];
      for (const rule of enabledRules(ctx)) {
        const r = evaluate(rule, device, { type: ev.type, payload });
        if (r.outcome === 'not_applicable') continue;
        if (r.outcome === 'out_of_scope') {
          logEval.run(ev.id, rule.id, ev.device_id, now, 'out_of_scope', r.reason, null);
          continue;
        }
        if (r.outcome === 'not_matched') {
          const cleared = rule.kind === 'threshold' ? conditionCleared(ctx, rule, ev.device_id, ev.ts, r.reason) : null;
          logEval.run(ev.id, rule.id, ev.device_id, now, cleared ? 'cleared' : 'not_matched', r.reason + (cleared ? ` — cleared incident #${cleared}` : ''), cleared);
          outcomes.push({ rule_id: rule.id, outcome: 'not_matched' });
          continue;
        }
        const t = trigger(ctx, rule, device, r.reason, { pk: ev.id, ts: ev.ts, late: !!ev.late, received_at: ev.received_at });
        const why =
          t.kind === 'created' ? `${r.reason} — opened incident #${t.incidentId}`
          : t.kind === 'reopened' ? `${r.reason} — re-opened incident #${t.incidentId} (within cooldown)`
          : `${r.reason} — de-duplicated into active incident #${t.incidentId}`;
        logEval.run(ev.id, rule.id, ev.device_id, now, t.kind === 'created' ? 'matched' : t.kind, why, t.incidentId);
        outcomes.push({ rule_id: rule.id, outcome: t.kind, incident_id: t.incidentId });
      }

      publish(ctx, 'event.processed', { id: ev.id, device_id: ev.device_id, status: 'processed', outcomes, processed_at: now });
      if (ev.type === 'telemetry') publish(ctx, 'device', deviceRow(ctx, ev.device_id));
    });
  }

  fail(ev: ClaimedEvent, err: unknown) {
    const { ctx } = this;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof LeaseLost) {
      ctx.log.warn({ event_pk: ev.id }, 'lease lost; another worker owns this event now');
      return;
    }
    const { maxAttempts, retryBaseMs } = ctx.config.worker;
    const dead = ev.attempts >= maxAttempts;
    const delay = Math.min(60_000, retryBaseMs * 2 ** (ev.attempts - 1)) * (0.8 + Math.random() * 0.4);
    ctx.db
      .prepare(
        `UPDATE events SET status = ?, next_attempt_at = ?, last_error = ?, lease_owner = NULL, lease_until = NULL
         WHERE id = ? AND lease_owner = ?`,
      )
      .run(dead ? 'failed' : 'pending', ctx.now() + delay, message, ev.id, this.owner);
    this.failedTotal++;
    const logCtx = { event_pk: ev.id, event_id: ev.event_id, device_id: ev.device_id, attempt: ev.attempts, err: message };
    if (dead) ctx.log.error(logCtx, 'event moved to dead-letter after max attempts');
    else ctx.log.warn({ ...logCtx, retry_in_ms: Math.round(delay) }, 'event processing failed; will retry');
    publish(ctx, 'event.processed', { id: ev.id, device_id: ev.device_id, status: dead ? 'failed' : 'pending', error: message, attempts: ev.attempts });
  }

  /** Claim and process one batch. Returns the number of events handled. */
  async tick(): Promise<number> {
    const chaos = getChaos(this.ctx);
    if (chaos.workerPaused) return 0;
    const batch = this.claim();
    for (const ev of batch) {
      if (chaos.processingDelayMs) await new Promise((r) => setTimeout(r, chaos.processingDelayMs));
      try {
        this.processOne(ev);
        this.processedTotal++;
      } catch (err) {
        this.fail(ev, err);
      }
    }
    return batch.length;
  }
}

/** Re-queue a dead-lettered event (operator action). */
export function requeueEvent(ctx: Ctx, id: number) {
  const r = ctx.db
    .prepare(`UPDATE events SET status = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL WHERE id = ? AND status = 'failed'`)
    .run(id);
  if (r.changes) {
    publish(ctx, 'event.processed', { id, status: 'pending' });
    ctx.log.info({ event_pk: id }, 'dead-lettered event re-queued by operator');
  }
  return r.changes > 0;
}
