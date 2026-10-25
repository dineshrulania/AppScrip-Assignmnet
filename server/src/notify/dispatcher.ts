import type { Ctx } from '../context.js';
import { publish } from '../changes.js';
import { timeline, incidentRow } from '../incidents.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Classic three-state circuit breaker. While the notification service is down we stop
 * hammering it (and stop burning retry attempts); after a cooldown one probe is let through.
 */
export class CircuitBreaker {
  state: BreakerState = 'closed';
  failures = 0;
  openedAt = 0;

  constructor(
    private threshold: number,
    private cooldownMs: number,
    private now: () => number,
  ) {}

  canAttempt(): boolean {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) this.state = 'half_open';
    return this.state !== 'open';
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
  }

  failure() {
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

export type Sender = (payload: unknown, idempotencyKey: string) => Promise<void>;

export const httpSender =
  (url: string, timeoutMs: number): Sender =>
  async (payload, idempotencyKey) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`notification service answered ${res.status}`);
  };

interface Row {
  id: number;
  incident_id: number;
  operator_id: string;
  idempotency_key: string;
  payload: string;
  attempts: number;
}

/**
 * Drains the notifications outbox. Delivery is at-least-once; the idempotency key lets the
 * receiving service drop duplicates (e.g. if we crash after it accepted but before we marked
 * the row sent). Notification failures never block event processing or incident creation.
 */
export class Dispatcher {
  breaker: CircuitBreaker;
  sentTotal = 0;
  failedTotal = 0;
  lastError: string | null = null;

  constructor(
    private ctx: Ctx,
    private send: Sender = httpSender(ctx.config.notifier.url, ctx.config.notifier.timeoutMs),
  ) {
    const c = ctx.config.notifier;
    this.breaker = new CircuitBreaker(c.breakerThreshold, c.breakerCooldownMs, ctx.now);
  }

  async tick(limit = 20): Promise<number> {
    const { ctx } = this;
    if (!this.breaker.canAttempt()) return 0;
    const rows = ctx.db
      .prepare(`SELECT id, incident_id, operator_id, idempotency_key, payload, attempts FROM notifications
                WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
      .all(ctx.now(), this.breaker.state === 'half_open' ? 1 : limit) as Row[];

    let handled = 0;
    for (const row of rows) {
      if (!this.breaker.canAttempt()) break;
      handled++;
      try {
        await this.send(JSON.parse(row.payload), row.idempotency_key);
        this.breaker.success();
        this.onSent(row);
      } catch (err) {
        this.breaker.failure();
        this.onFailed(row, err instanceof Error ? err.message : String(err));
      }
    }
    return handled;
  }

  private onSent(row: Row) {
    const { ctx } = this;
    const name = JSON.parse(row.payload)?.to?.name ?? row.operator_id;
    ctx.db.prepare(`UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`).run(ctx.now(), row.id);
    timeline(ctx, row.incident_id, 'notified', 'notifier', `Notified ${name}${row.attempts ? ` (after ${row.attempts} failed attempt(s))` : ''}`);
    this.sentTotal++;
    ctx.log.info({ notification_id: row.id, incident_id: row.incident_id, operator: row.operator_id }, 'notification delivered');
    publish(ctx, 'notification', { id: row.id, incident_id: row.incident_id, status: 'sent' });
    publish(ctx, 'incident', incidentRow(ctx, row.incident_id));
  }

  private onFailed(row: Row, message: string) {
    const { ctx } = this;
    const c = ctx.config.notifier;
    const attempts = row.attempts + 1;
    const dead = attempts >= c.maxAttempts;
    const delay = Math.min(c.retryMaxMs, c.retryBaseMs * 2 ** (attempts - 1));
    ctx.db
      .prepare('UPDATE notifications SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(dead ? 'dead' : 'pending', attempts, ctx.now() + delay, message, row.id);
    this.failedTotal++;
    this.lastError = message;
    if (attempts === 1 || dead)
      timeline(ctx, row.incident_id, dead ? 'notify_dead' : 'notify_retry', 'notifier',
        dead ? `Gave up notifying ${row.operator_id} after ${attempts} attempts: ${message}` : `Notification to ${row.operator_id} failed (${message}); retrying with backoff`);
    ctx.log.warn({ notification_id: row.id, attempts, dead, err: message, breaker: this.breaker.state }, 'notification delivery failed');
    publish(ctx, 'notification', { id: row.id, incident_id: row.incident_id, status: dead ? 'dead' : 'pending', error: message });
  }
}
