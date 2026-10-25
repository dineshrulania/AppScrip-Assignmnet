import { describe, expect, it } from 'vitest';
import { Scanner } from '../src/scanner.js';
import { T0, addDevice, apiAlive, makeCtx, row, send, tele } from './helpers.js';

describe('silence detection (scanner)', () => {
  it('marks devices offline and opens a "stopped reporting" incident after the configured duration', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const scanner = new Scanner(ctx);
    apiAlive(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 })]);

    ctx.advance(25_000);
    apiAlive(ctx, T0);
    scanner.run();
    expect(row(ctx, "SELECT status FROM devices WHERE id='cs-1'").status).toBe('offline');
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(0); // offline 25s < 30s rule

    ctx.advance(10_000);
    apiAlive(ctx, T0);
    scanner.run();
    scanner.run(); // repeated scans don't duplicate
    const inc = row(ctx, 'SELECT title, summary, status FROM incidents');
    expect(inc.title).toMatch(/stopped reporting/);
    expect(inc.summary).toMatch(/no data for 35s/);
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1);
  });

  it('auto-resolves when the device reconnects and replays its buffer', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const scanner = new Scanner(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 }, 'first')]);
    ctx.advance(40_000);
    apiAlive(ctx, T0);
    scanner.run();
    expect(row(ctx, 'SELECT status FROM incidents').status).toBe('open');

    send(ctx, 'cs-1', Array.from({ length: 20 }, (_, i) => tele(T0 + i * 2000, { temperature: 4 }, `buf${i}`)));
    const inc = row(ctx, 'SELECT status, resolved_by, resolution_note FROM incidents');
    expect(inc).toMatchObject({ status: 'resolved', resolved_by: 'system' });
    expect(inc.resolution_note).toMatch(/reconnected after 40s/);
    expect(row(ctx, "SELECT status FROM devices WHERE id='cs-1'").status).toBe('online');
  });

  it('does not blame devices when the ingestion API itself is down', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    const scanner = new Scanner(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 })]);
    apiAlive(ctx, T0);
    ctx.advance(60_000); // API heartbeat now stale
    scanner.run();
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(0);
  });

  it('after a platform restart, silence is only counted from when ingestion came back', () => {
    const ctx = makeCtx();
    addDevice(ctx);
    send(ctx, 'cs-1', [tele(T0, { temperature: 4 })]);
    ctx.advance(10 * 60_000); // platform was down for 10 minutes
    const scanner = new Scanner(ctx);
    apiAlive(ctx);
    scanner.run();
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(0); // grace period, no alert storm
    ctx.advance(31_000);
    apiAlive(ctx, ctx.now() - 31_000);
    scanner.run();
    expect(row(ctx, 'SELECT COUNT(*) n FROM incidents').n).toBe(1); // still silent after a full window -> real
  });
});
