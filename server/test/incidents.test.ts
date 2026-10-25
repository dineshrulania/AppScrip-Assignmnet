import { describe, expect, it } from 'vitest';
import { acknowledge, resolve } from '../src/incidents.js';
import { DEVICES, T0, addDevice, drain, makeCtx, row, rows, send, tele } from './helpers.js';

describe('rules -> incidents', () => {
  it('opens an incident with event details, notifies routed operators via the outbox', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 9.4 }, 'hot')]);
    await drain(ctx);
    const inc = row(ctx, 'SELECT * FROM incidents');
    expect(inc).toMatchObject({ status: 'open', severity: 'critical', device_id: 'cs-1', trigger_count: 1 });
    expect(inc.summary).toContain('temperature = 9.4 > 8');
    expect(row(ctx, 'SELECT COUNT(*) n FROM incident_events WHERE incident_id = ?', inc.id).n).toBe(1);
    // North Warehouse -> Sara (location owner) + NOC (critical only)
    expect(rows(ctx, 'SELECT operator_id FROM notifications ORDER BY operator_id').map((r) => r.operator_id)).toEqual(['op-noc', 'op-sara']);
  });

  it('de-duplicates: 50 matching readings produce ONE incident with 50 linked events', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', Array.from({ length: 50 }, (_, i) => tele(T0 + i * 1000, { temperature: 10 + i / 10 }, `h${i}`)));
    await drain(ctx);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1);
    expect(row(ctx, 'SELECT trigger_count FROM incidents').trigger_count).toBe(50);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incident_events').n).toBe(50);
    expect(row(ctx, 'SELECT COUNT(*) n FROM notifications').n).toBe(2); // not 100
  });

  it('acknowledged incidents absorb repeats; a match within cooldown after resolve re-opens instead of duplicating', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    await drain(ctx);
    const id = row(ctx, 'SELECT id FROM incidents').id;
    acknowledge(ctx, id, 'sara');
    send(ctx, 'cs-1', [tele(T0 + 1000, { temperature: 12 }, 'b')]);
    await drain(ctx);
    expect(row(ctx, 'SELECT status, trigger_count FROM incidents WHERE id = ?', id)).toEqual({ status: 'acknowledged', trigger_count: 2 });

    resolve(ctx, id, 'sara', 'door was left open');
    ctx.advance(30_000); // cooldown for this rule is 120s
    send(ctx, 'cs-1', [tele(T0 + 31_000, { temperature: 12 }, 'c')]);
    await drain(ctx);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1);
    expect(row(ctx, 'SELECT status FROM incidents WHERE id = ?', id).status).toBe('open');
    expect(rows(ctx, 'SELECT kind FROM incident_timeline WHERE incident_id = ?', id).map((r) => r.kind)).toContain('reopened');

    resolve(ctx, id, 'sara', 'fixed for real');
    ctx.advance(10 * 60_000); // well past cooldown -> genuinely new incident
    send(ctx, 'cs-1', [tele(ctx.now(), { temperature: 12 }, 'd')]);
    await drain(ctx);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(2);
  });

  it('enforces valid state transitions and optimistic concurrency', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 12 }, 'a')]);
    await drain(ctx);
    const inc = row(ctx, 'SELECT id, version FROM incidents');
    expect(() => acknowledge(ctx, inc.id, 'a', inc.version + 5)).toThrow(/changed since/);
    acknowledge(ctx, inc.id, 'a', inc.version);
    expect(() => acknowledge(ctx, inc.id, 'b')).toThrow(/cannot acknowledge/);
    resolve(ctx, inc.id, 'a', '');
    expect(() => resolve(ctx, inc.id, 'b', '')).toThrow(/already resolved/);
  });

  it('out-of-order safety: an older replayed "normal" reading does not clear a newer breach', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 11 }, 'breach')]);
    await drain(ctx);
    send(ctx, 'cs-1', [tele(T0 - 60_000, { temperature: 4 }, 'old-normal')]);
    await drain(ctx);
    expect(row(ctx, 'SELECT condition_active FROM incidents').condition_active).toBe(1);
    // device's displayed latest reading is still the newer one
    expect(JSON.parse(row(ctx, "SELECT latest FROM devices WHERE id='cs-1'").latest).temperature.v).toBe(11);

    send(ctx, 'cs-1', [tele(T0 + 60_000, { temperature: 4 }, 'new-normal')]);
    await drain(ctx);
    expect(row(ctx, 'SELECT condition_active, status FROM incidents')).toEqual({ condition_active: 0, status: 'open' });
  });

  it('applies a shuffled batch in device-time order', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0 + 2000, { temperature: 6 }, 'c', 3), tele(T0, { temperature: 4 }, 'a', 1), tele(T0 + 1000, { temperature: 5 }, 'b', 2)]);
    await drain(ctx);
    const d = row(ctx, "SELECT latest, last_seq, last_event_ts FROM devices WHERE id='cs-1'");
    expect(JSON.parse(d.latest).temperature.v).toBe(6);
    expect(d.last_seq).toBe(3);
    expect(d.last_event_ts).toBe(T0 + 2000);
  });

  it('marks incidents detected from replayed (late) events', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0 - 4 * 60_000, { temperature: 13 }, 'while-offline')]);
    await drain(ctx);
    const inc = row(ctx, 'SELECT detected_late, summary FROM incidents');
    expect(inc.detected_late).toBe(1);
    expect(inc.summary).toMatch(/Detected late/);
  });

  it('records a decision log explaining why rules did or did not fire', async () => {
    const ctx = makeCtx();
    addDevice(ctx, DEVICES.hvac);
    send(ctx, 'hvac-1', [tele(T0, { temperature: 25 }, 'normal')]);
    await drain(ctx);
    const log = rows(ctx, 'SELECT r.name, e.outcome, e.reason FROM rule_evaluations e JOIN rules r ON r.id = e.rule_id ORDER BY e.id');
    expect(log).toEqual(
      expect.arrayContaining([
        { name: 'Server room overheating', outcome: 'not_matched', reason: 'temperature = 25, not > 30' },
        expect.objectContaining({ name: 'Cold-chain temperature breach', outcome: 'out_of_scope' }),
      ]),
    );
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(0);
  });

  it('event_type rules fire on the reported event', async () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [{ event_id: 'f1', type: 'fault', ts: T0, payload: { code: 'E501' } }]);
    await drain(ctx);
    expect(row(ctx, 'SELECT title FROM incidents').title).toMatch(/Hardware fault/);
  });
});
