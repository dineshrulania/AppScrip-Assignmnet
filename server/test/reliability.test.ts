import { describe, expect, it } from 'vitest';
import { Processor, requeueEvent } from '../src/worker.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { setChaos } from '../src/settings.js';
import { T0, addDevice, drain, makeCtx, row, rows, send, tele } from './helpers.js';

describe('failure handling', () => {
  it('a processing failure rolls back completely and is retried with backoff', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    setChaos(ctx, { processingFailureRate: 1 });
    const p = new Processor(ctx);
    await p.tick();
    const ev = row(ctx, 'SELECT status, attempts, last_error, next_attempt_at FROM events');
    expect(ev).toMatchObject({ status: 'pending', attempts: 1, last_error: expect.stringMatching(/injected/) });
    expect(ev.next_attempt_at).toBeGreaterThan(ctx.now());
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(0); // no partial side effects

    setChaos(ctx, { processingFailureRate: 0 });
    expect(await p.tick()).toBe(0); // backoff not elapsed yet
    ctx.advance(5000);
    await p.tick();
    expect(row(ctx, 'SELECT status FROM events').status).toBe('processed');
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1);
  });

  it('dead-letters an event after max attempts; an operator can re-queue it', async () => {
    const ctx = makeCtx((c) => (c.worker.maxAttempts = 3));
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'poison')]);
    setChaos(ctx, { processingFailureRate: 1 });
    const p = new Processor(ctx);
    for (let i = 0; i < 3; i++) {
      await p.tick();
      ctx.advance(60_000);
    }
    expect(row(ctx, 'SELECT status, attempts FROM events')).toEqual({ status: 'failed', attempts: 3 });
    expect(await p.tick()).toBe(0); // parked, not retried forever

    setChaos(ctx, { processingFailureRate: 0 });
    expect(requeueEvent(ctx, row(ctx, 'SELECT id FROM events').id)).toBe(true);
    await p.tick();
    expect(row(ctx, 'SELECT status FROM events').status).toBe('processed');
  });

  it('a crashed worker\'s claimed events are reclaimed after the lease expires, and processed once', async () => {
    const ctx = makeCtx((c) => (c.worker.leaseMs = 10_000));
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a'), tele(T0 + 1, { temperature: 13 }, 'b')]);

    const crashed = new Processor(ctx);
    expect(crashed.claim()).toHaveLength(2); // claimed... then the process dies
    const survivor = new Processor(ctx);
    expect(await survivor.tick()).toBe(0); // still leased

    ctx.advance(11_000);
    expect(await survivor.tick()).toBe(2);
    expect(rows(ctx, 'SELECT status FROM events').every((e) => e.status === 'processed')).toBe(true);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incident_events').n).toBe(2);
  });

  it('fencing: a slow worker whose lease was taken over cannot commit a second time', async () => {
    const ctx = makeCtx((c) => (c.worker.leaseMs = 10_000));
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    const slow = new Processor(ctx);
    const [ev] = slow.claim();
    ctx.advance(11_000);
    await new Processor(ctx).tick(); // takes over and processes
    expect(() => slow.processOne(ev)).toThrow(/lease/);
    expect(row(ctx, 'SELECT trigger_count FROM incidents').trigger_count).toBe(1);
  });

  it('notification outage: incidents still open, delivery retries, breaker opens, then delivers exactly once', async () => {
    const ctx = makeCtx((c) => {
      c.notifier.breakerThreshold = 2;
      c.notifier.breakerCooldownMs = 5000;
    });
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    await drain(ctx);
    expect(row(ctx, "SELECT status FROM incidents").status).toBe('open'); // not blocked by the outage

    let up = false;
    const received = new Map<string, number>();
    const d = new Dispatcher(ctx, async (_payload, key) => {
      if (!up) throw new Error('503 service unavailable');
      received.set(key, (received.get(key) ?? 0) + 1);
    });

    await d.tick();
    expect(d.breaker.state).toBe('open');
    expect(row(ctx, "SELECT COUNT(*) n FROM notifications WHERE status = 'pending' AND attempts > 0").n).toBeGreaterThan(0);
    expect(await d.tick()).toBe(0); // breaker open: not hammering the dead service

    up = true;
    ctx.advance(120_000);
    await d.tick(); // half-open probe succeeds -> closed
    await d.tick();
    expect(d.breaker.state).toBe('closed');
    expect(row(ctx, "SELECT COUNT(*) n FROM notifications WHERE status = 'sent'").n).toBe(2);
    expect([...received.values()].every((n) => n === 1)).toBe(true);
    expect(rows(ctx, "SELECT kind FROM incident_timeline").map((r) => r.kind)).toEqual(
      expect.arrayContaining(['opened', 'notify_retry', 'notified']),
    );
  });

  it('gives up on a notification after max attempts and surfaces it', async () => {
    const ctx = makeCtx((c) => {
      c.notifier.maxAttempts = 2;
      c.notifier.breakerThreshold = 100;
    });
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    await drain(ctx);
    const d = new Dispatcher(ctx, async () => {
      throw new Error('boom');
    });
    for (let i = 0; i < 3; i++) {
      await d.tick();
      ctx.advance(120_000);
    }
    expect(row(ctx, "SELECT COUNT(*) n FROM notifications WHERE status = 'dead'").n).toBe(2);
  });

  it('a paused worker builds a backlog without losing events, then catches up', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    setChaos(ctx, { workerPaused: true });
    send(ctx, 'cs-1', Array.from({ length: 300 }, (_, i) => tele(T0 + i, { temperature: 4 }, `p${i}`)));
    const p = new Processor(ctx);
    expect(await p.tick()).toBe(0);
    setChaos(ctx, { workerPaused: false });
    await drain(ctx, p);
    expect(row(ctx, "SELECT COUNT(*) n FROM events WHERE status = 'processed'").n).toBe(300);
  });
});
