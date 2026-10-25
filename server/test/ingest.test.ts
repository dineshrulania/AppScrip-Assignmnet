import { describe, expect, it } from 'vitest';
import { IngestError, authenticateDevice, ingest } from '../src/ingest.js';
import { DEVICES, T0, addDevice, makeCtx, row, send, tele } from './helpers.js';

describe('ingestion', () => {
  it('accepts valid events and stores them as pending work', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const r = send(ctx, 'cs-1', [tele(T0, { temperature: 4 }, 'a'), tele(T0 + 1, { temperature: 5 }, 'b')]);
    expect(r).toMatchObject({ accepted: 2, duplicates: 0, rejected: [], results: ['accepted', 'accepted'] });
    expect(row(ctx, "SELECT COUNT(*) n FROM events WHERE status = 'pending'").n).toBe(2);
  });

  it('is idempotent: re-delivering the same events stores them once', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const batch = [tele(T0, { temperature: 4 }, 'a'), tele(T0 + 1, { temperature: 5 }, 'b')];
    send(ctx, 'cs-1', batch);
    const again = send(ctx, 'cs-1', batch); // device never got our ack and retried
    expect(again).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(row(ctx, 'SELECT COUNT(*) n FROM events').n).toBe(2);
    expect(row(ctx, "SELECT duplicates_total FROM devices WHERE id = 'cs-1'").duplicates_total).toBe(2);
  });

  it('de-duplicates per device: two devices may reuse the same event_id', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    addDevice(ctx, DEVICES.hvac);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 }, 'same')]);
    expect(send(ctx, 'hvac-1', [tele(T0, { temperature: 22 }, 'same')]).accepted).toBe(1);
  });

  it('rejects malformed events individually without failing the batch', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const r = send(ctx, 'cs-1', [
      tele(T0, { temperature: 4 }, 'ok'),
      tele(T0, { temperature: 'hot' }, 'bad-metric'),
      { event_id: 'no-type', ts: T0, payload: {} },
      { event_id: 'bad-ts', type: 'telemetry', ts: 'yesterday', payload: { t: 1 } },
      'not even an object',
    ]);
    expect(r.accepted).toBe(1);
    expect(r.results).toEqual(['accepted', 'rejected', 'rejected', 'rejected', 'rejected']);
    expect(r.rejected[0].errors[0]).toMatch(/temperature.*finite number/);
    expect(row(ctx, 'SELECT COUNT(*) n FROM rejected_events').n).toBe(4);
  });

  it('rejects events from the far future (clock skew) and spoofed device ids', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const r = send(ctx, 'cs-1', [
      tele(T0 + 3600_000, { temperature: 4 }, 'future'),
      { ...tele(T0, { temperature: 4 }, 'spoof'), device_id: 'someone-else' },
    ]);
    expect(r.accepted).toBe(0);
    expect(r.rejected.map((x) => x.errors[0])).toEqual([expect.stringMatching(/future/), expect.stringMatching(/does not match/)]);
  });

  it('flags late (replayed) and out-of-order events', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 }, 'new')]);
    send(ctx, 'cs-1', [tele(T0 - 5 * 60_000, { temperature: 4 }, 'old')]);
    const old = row(ctx, "SELECT late, out_of_order FROM events WHERE event_id = 'old'");
    expect(old).toEqual({ late: 1, out_of_order: 1 });
  });

  it('applies backpressure (429 + Retry-After) above the high watermark and accepts nothing', () => {
    const ctx = makeCtx((c) => (c.ingest.highWatermark = 3));
    addDevice(ctx);
    send(ctx, 'cs-1', [1, 2, 3].map((i) => tele(T0, { temperature: 4 }, `x${i}`)));
    ctx.advance(1000); // let the depth cache expire
    try {
      send(ctx, 'cs-1', [tele(T0, { temperature: 4 }, 'over')]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IngestError);
      expect((e as IngestError).status).toBe(429);
      expect((e as IngestError).retryAfterSec).toBeGreaterThan(0);
    }
    expect(row(ctx, "SELECT COUNT(*) n FROM events WHERE event_id = 'over'").n).toBe(0);
  });

  it('rejects oversized batches and unknown device keys', () => {
    const ctx = makeCtx((c) => (c.ingest.maxBatch = 2));
    addDevice(ctx);
    expect(() => ingest(ctx, 'cs-1', [1, 2, 3])).toThrow(/batch too large/);
    expect(() => authenticateDevice(ctx, 'Bearer nope')).toThrow(/unknown/);
    expect(() => authenticateDevice(ctx, undefined)).toThrow(/missing/);
  });

  it('updates liveness at ingest time (not processing time)', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    ctx.advance(5000);
    send(ctx, 'cs-1', [tele(ctx.now(), { temperature: 4 })]);
    expect(row(ctx, "SELECT status, last_seen_at FROM devices WHERE id = 'cs-1'")).toEqual({ status: 'online', last_seen_at: ctx.now() });
  });
});
