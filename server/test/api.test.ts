import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChangeHub, buildApp } from '../src/app.js';
import { T0, drain, makeCtx, tele } from './helpers.js';

const setup = () => {
  const ctx = makeCtx();
  const hub = new ChangeHub(ctx);
  return { ctx, hub, app: buildApp(ctx, hub) };
};

const register = async (app: ReturnType<typeof buildApp>) => {
  const r = await app.inject({
    method: 'POST', url: '/api/v1/devices/register', headers: { 'x-enrollment-token': 'dev-enrollment-token' },
    payload: { device_id: 'cs-1', location: 'North Warehouse', type: 'cold_storage' },
  });
  return r.json().device_key as string;
};

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  write(c: string) {
    this.chunks.push(c);
    return true;
  }
  end() {}
  get text() {
    return this.chunks.join('');
  }
}

describe('HTTP API', () => {
  it('device enrolment requires the enrollment token; ingest requires the device key', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/v1/devices/register', payload: {} })).statusCode).toBe(401);
    const key = await register(app);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/ingest', payload: { events: [] } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${key}` },
      payload: { events: [tele(T0, { temperature: 12 }, 'x')] },
    });
    expect(ok.json()).toMatchObject({ accepted: 1 });
  });

  it('returns 429 with Retry-After under backpressure', async () => {
    const { app, ctx } = setup();
    ctx.config.ingest.highWatermark = 1;
    const key = await register(app);
    const post = (id: string) =>
      app.inject({ method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: [tele(T0, { temperature: 1 }, id)] });
    await post('a');
    ctx.advance(1000);
    const r = await post('b');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('2');
  });

  it('operator flow: list incident, inspect with events + timeline, acknowledge, resolve, 409 on stale action', async () => {
    const { app, ctx } = setup();
    const key = await register(app);
    await app.inject({ method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: [tele(T0, { temperature: 12 }, 'x')] });
    await drain(ctx);
    const [inc] = (await app.inject('/api/incidents')).json();
    const detail = (await app.inject(`/api/incidents/${inc.id}`)).json();
    expect(detail.events).toHaveLength(1);
    expect(detail.timeline[0].kind).toBe('opened');
    expect((await app.inject({ method: 'POST', url: `/api/incidents/${inc.id}/acknowledge`, payload: { actor: 'sara' } })).json().status).toBe('acknowledged');
    expect((await app.inject({ method: 'POST', url: `/api/incidents/${inc.id}/acknowledge`, payload: { actor: 'james' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/incidents/${inc.id}/resolve`, payload: { actor: 'sara', note: 'ok' } })).json().status).toBe('resolved');
  });

  it('event detail explains why no incident was created', async () => {
    const { app, ctx } = setup();
    const key = await register(app);
    await app.inject({ method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: [tele(T0, { temperature: 5 }, 'x')] });
    await drain(ctx);
    const ev = (await app.inject('/api/events/1')).json();
    expect(ev.incidents).toHaveLength(0);
    expect(ev.evaluations.find((e: any) => e.rule_name === 'Cold-chain temperature breach').reason).toBe('temperature = 5, not > 8');
    expect(ev.skipped.find((s: any) => s.rule_name === 'Device stopped reporting').reason).toMatch(/time-based/);
  });

  it('rules: create with validation, dry-run preview, toggle', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/rules', payload: { name: 'x', kind: 'threshold', config: {} } })).statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST', url: '/api/rules',
      payload: { name: 'Humidity high', kind: 'threshold', severity: 'medium', config: { metric: 'humidity', operator: '>', value: 80 } },
    });
    expect(created.statusCode).toBe(201);
    const preview = await app.inject({ method: 'POST', url: '/api/rules/preview', payload: { name: 'p', kind: 'event_type', config: { event_type: 'fault' } } });
    expect(preview.json()).toMatchObject({ matched: 0 });
    const toggled = await app.inject({ method: 'PATCH', url: `/api/rules/${created.json().id}`, payload: { enabled: false } });
    expect(toggled.json().enabled).toBe(false);
  });

  it('health, readiness and metrics endpoints', async () => {
    const { app } = setup();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(503); // no worker heartbeat in this test
    expect(ready.json().checks.worker.ok).toBe(false);
    expect((await app.inject('/metrics')).body).toContain('netwatch_queue_depth');
  });

  it('live stream: a reconnecting dashboard receives exactly the changes it missed', async () => {
    const { app, ctx, hub } = setup();
    const key = await register(app);
    const first = new FakeRes();
    hub.attach(first as any, null);
    const cursorAtDisconnect = hub.cursor;
    first.emit('close'); // connection drops

    await app.inject({ method: 'POST', url: '/api/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: [tele(T0, { temperature: 12 }, 'while-away')] });
    await drain(ctx);

    const second = new FakeRes();
    const r = hub.attach(second as any, cursorAtDisconnect);
    expect(r.mode).toBe('resumed');
    expect(r.replayed).toBeGreaterThan(0);
    expect(second.text).toContain('while-away');
    expect(second.text).toContain('event: incident');

    const stale = new FakeRes();
    expect(hub.attach(stale as any, hub.cursor + 999).mode).toBe('reset'); // e.g. server DB was wiped
  });
});
