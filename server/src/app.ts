import Fastify, { LogController, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Ctx } from './context.js';
import { json } from './db.js';
import { changesSince, latestChangeId, oldestChangeId, publish } from './changes.js';
import { IngestError, authenticateDevice, deviceRow, ingest, registerDevice } from './ingest.js';
import { TransitionError, acknowledge, incidentDetail, incidentRow, resolve } from './incidents.js';
import { RuleInput, evaluate, getRule, inScope, invalidateRuleCache, listRules, saveRule } from './rules.js';
import { overview, prometheus, systemHealth, timeseries } from './stats.js';
import { setChaos } from './settings.js';
import { requeueEvent } from './worker.js';

// ---------------------------------------------------------------------------
// Live updates: one poller tails the durable change feed and fans out over SSE.
// ---------------------------------------------------------------------------

interface Client {
  res: ServerResponse;
}

export class ChangeHub {
  cursor: number;
  clients = new Set<Client>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private ctx: Ctx) {
    this.cursor = latestChangeId(ctx);
  }

  start() {
    this.timers.push(setInterval(() => this.poll(), this.ctx.config.changes.pollMs));
    // Ephemeral stats snapshot (no SSE id, so it never affects resume position).
    this.timers.push(setInterval(() => this.clients.size && this.broadcast(`event: stats\ndata: ${JSON.stringify(overview(this.ctx))}\n\n`), 2000));
    this.timers.push(setInterval(() => this.broadcast(': keep-alive\n\n'), 15_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  poll() {
    for (;;) {
      const rows = changesSince(this.ctx, this.cursor, 500);
      if (!rows.length) return;
      this.cursor = rows[rows.length - 1].id;
      if (this.clients.size) this.broadcast(rows.map(frame).join(''));
    }
  }

  private broadcast(chunk: string) {
    for (const c of this.clients) c.res.write(chunk);
  }

  /** Attach a client, replaying everything it missed since `since` (from Last-Event-ID). */
  attach(res: ServerResponse, since: number | null) {
    this.poll(); // bring cursor up to date so replay + live stream are gap-free
    const oldest = oldestChangeId(this.ctx);
    let replayed = 0;
    let mode: 'fresh' | 'resumed' | 'reset' = 'fresh';
    if (since !== null) {
      if (since > this.cursor || (oldest && since < oldest - 1)) {
        mode = 'reset'; // gap is outside retention (or server DB was reset): client must refetch snapshots
      } else {
        mode = 'resumed';
        let from = since;
        while (from < this.cursor) {
          const rows = changesSince(this.ctx, from, 1000).filter((r) => r.id <= this.cursor);
          if (!rows.length) break;
          res.write(rows.map(frame).join(''));
          replayed += rows.length;
          from = rows[rows.length - 1].id;
        }
      }
    }
    res.write(`id: ${this.cursor}\nevent: hello\ndata: ${JSON.stringify({ mode, replayed, cursor: this.cursor, server_time: this.ctx.now() })}\n\n`);
    const client = { res };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    return { mode, replayed };
  }
}

const frame = (r: { id: number; topic: string; data: string }) => `id: ${r.id}\nevent: ${r.topic}\ndata: ${r.data}\n\n`;

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const ActorBody = z.object({ actor: z.string().min(1).max(80).default('operator'), version: z.number().int().optional() });
const ResolveBody = ActorBody.extend({ note: z.string().max(2000).default('') });
const RegisterBody = z.object({
  device_id: z.string().regex(/^[A-Za-z0-9_.:-]{3,64}$/),
  name: z.string().max(120).optional(),
  location: z.string().min(1).max(120),
  type: z.string().min(1).max(64),
});

export function buildApp(ctx: Ctx, hub: ChangeHub) {
  const app = Fastify({
    loggerInstance: ctx.log,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  });
  app.register(cors, { origin: true });

  // Log failures and slow requests only; successful polling would drown the useful lines.
  app.addHook('onResponse', async (req, reply) => {
    const ms = reply.elapsedTime;
    if (reply.statusCode >= 400 || ms > 500)
      req.log.info({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(ms) }, 'request');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation_failed', issues: err.issues });
    if (err instanceof IngestError) {
      if (err.retryAfterSec) reply.header('retry-after', String(err.retryAfterSec));
      return reply.code(err.status).send({ error: err.message });
    }
    if (err instanceof TransitionError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error', request_id: req.id });
  });

  // ---- Health ------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok', pid: process.pid, uptime_s: Math.round(process.uptime()) }));
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      ctx.db.prepare('SELECT 1').get();
      checks.database = { ok: true };
    } catch (e: any) {
      checks.database = { ok: false, detail: e.message };
    }
    const sys = systemHealth(ctx);
    const worker = sys.components.find((c) => c.component === 'worker');
    checks.worker = { ok: !!worker?.healthy, detail: worker ? `last heartbeat ${Math.round(worker.age_ms / 1000)}s ago` : 'never seen' };
    const o = overview(ctx);
    checks.backlog = { ok: o.queue.depth < o.queue.high_watermark, detail: `${o.queue.depth} queued / watermark ${o.queue.high_watermark}` };
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(prometheus(ctx)));

  // ---- Device-facing API -------------------------------------------------
  app.post('/api/v1/devices/register', async (req, reply) => {
    if (req.headers['x-enrollment-token'] !== ctx.config.enrollmentToken)
      return reply.code(401).send({ error: 'invalid enrollment token' });
    return reply.code(201).send(registerDevice(ctx, RegisterBody.parse(req.body)));
  });

  app.post('/api/v1/ingest', async (req) => {
    const device = authenticateDevice(ctx, req.headers.authorization);
    return ingest(ctx, device.id, req.body);
  });

  // ---- Operator API ------------------------------------------------------
  app.get('/api/devices', async () => {
    const rows = ctx.db
      .prepare(
        `SELECT d.id, d.name, d.location, d.type, d.created_at, d.last_seen_at, d.last_event_ts, d.last_seq, d.boot_id, d.status,
                d.status_since, d.latest, d.events_total, d.duplicates_total, d.late_total,
                (SELECT COUNT(*) FROM incidents i WHERE i.device_id = d.id AND i.status != 'resolved') AS active_incidents
         FROM devices d ORDER BY d.location, d.id`,
      )
      .all() as any[];
    return rows.map((r) => ({ ...r, latest: json(r.latest, {}) }));
  });

  app.get<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    const d = deviceRow(ctx, req.params.id);
    if (!d) return reply.code(404).send({ error: 'device not found' });
    const since = ctx.now() - 30 * 60_000;
    const readings = (ctx.db
      .prepare(`SELECT ts, payload FROM events WHERE device_id = ? AND type = 'telemetry' AND ts > ? ORDER BY ts`)
      .all(d.id, since) as any[]).map((r) => ({ ts: r.ts, ...json(r.payload, {}) }));
    const incidents = ctx.db.prepare('SELECT id, title, status, severity, opened_at FROM incidents WHERE device_id = ? ORDER BY id DESC LIMIT 20').all(d.id);
    const log = ctx.db.prepare('SELECT at, kind, detail FROM device_log WHERE device_id = ? ORDER BY id DESC LIMIT 30').all(d.id);
    return { ...d, readings, incidents, log };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/events', async (req) => {
    const q = req.query;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.device_id) (where.push('device_id = ?'), params.push(q.device_id));
    if (q.type) (where.push('type = ?'), params.push(q.type));
    if (q.status) (where.push('status = ?'), params.push(q.status));
    if (q.late === '1') where.push('late = 1');
    if (q.before_id) (where.push('id < ?'), params.push(Number(q.before_id)));
    const limit = Math.min(500, Number(q.limit) || 100);
    const rows = ctx.db
      .prepare(`SELECT id, device_id, event_id, seq, type, ts, received_at, payload, late, out_of_order, status, attempts, last_error, processed_at
                FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`)
      .all(...params) as any[];
    return rows.map((e) => ({ ...e, payload: json(e.payload, {}), late: !!e.late, out_of_order: !!e.out_of_order }));
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const e = ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)) as any;
    if (!e) return reply.code(404).send({ error: 'event not found' });
    const evaluations = ctx.db
      .prepare(`SELECT ev.*, r.name AS rule_name, r.kind AS rule_kind FROM rule_evaluations ev JOIN rules r ON r.id = ev.rule_id WHERE ev.event_pk = ? ORDER BY ev.id`)
      .all(e.id);
    // Rules that never looked at this event (not applicable) are listed too - "why no incident?"
    const evaluatedIds = new Set((evaluations as any[]).map((x) => x.rule_id));
    const skipped = listRules(ctx)
      .filter((r) => !evaluatedIds.has(r.id))
      .map((r) => ({
        rule_id: r.id,
        rule_name: r.name,
        reason: !r.enabled ? 'rule disabled'
          : r.kind === 'absence' ? 'time-based rule (evaluated by scanner, not per event)'
          : r.kind === 'threshold' ? `event has no "${(r.config as any).metric}" metric`
          : `event type is "${e.type}", rule watches "${(r.config as any).event_type}"`,
      }));
    const incidents = ctx.db
      .prepare('SELECT i.id, i.title, i.status, i.severity FROM incident_events ie JOIN incidents i ON i.id = ie.incident_id WHERE ie.event_pk = ?')
      .all(e.id);
    return { ...e, payload: json(e.payload, {}), late: !!e.late, out_of_order: !!e.out_of_order, evaluations, skipped, incidents };
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/requeue', async (req, reply) =>
    requeueEvent(ctx, Number(req.params.id)) ? { ok: true } : reply.code(409).send({ error: 'event is not in the dead-letter state' }),
  );

  app.get<{ Querystring: Record<string, string> }>('/api/incidents', async (req) => {
    const s = req.query.status ?? 'active';
    const filter = s === 'all' ? '' : s === 'active' ? "WHERE i.status != 'resolved'" : 'WHERE i.status = ?';
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const ids = ctx.db
      .prepare(`SELECT i.id FROM incidents i ${filter} ORDER BY i.status = 'resolved', i.last_triggered_at DESC LIMIT ${limit}`)
      .all(...(filter.includes('?') ? [s] : [])) as { id: number }[];
    return ids.map(({ id }) => incidentRow(ctx, id));
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (req, reply) => {
    const d = incidentDetail(ctx, Number(req.params.id));
    return d ?? reply.code(404).send({ error: 'incident not found' });
  });

  app.post<{ Params: { id: string } }>('/api/incidents/:id/acknowledge', async (req) => {
    const b = ActorBody.parse(req.body ?? {});
    return ctx.db.transaction(() => acknowledge(ctx, Number(req.params.id), b.actor, b.version)).immediate();
  });

  app.post<{ Params: { id: string } }>('/api/incidents/:id/resolve', async (req) => {
    const b = ResolveBody.parse(req.body ?? {});
    return ctx.db.transaction(() => resolve(ctx, Number(req.params.id), b.actor, b.note, false, b.version)).immediate();
  });

  // ---- Rules -------------------------------------------------------------
  app.get('/api/rules', async () => {
    const stats = ctx.db
      .prepare(`SELECT rule_id, SUM(outcome IN ('matched','linked','reopened')) matches, MAX(CASE WHEN outcome IN ('matched','linked','reopened') THEN at END) last_match
                FROM rule_evaluations WHERE at > ? GROUP BY rule_id`)
      .all(ctx.now() - 3600_000) as any[];
    const byId = new Map(stats.map((s) => [s.rule_id, s]));
    const active = ctx.db.prepare(`SELECT rule_id, COUNT(*) n FROM incidents WHERE status != 'resolved' GROUP BY rule_id`).all() as any[];
    const activeById = new Map(active.map((a) => [a.rule_id, a.n]));
    return listRules(ctx).map((r) => ({ ...r, matches_1h: byId.get(r.id)?.matches ?? 0, last_match: byId.get(r.id)?.last_match ?? null, active_incidents: activeById.get(r.id) ?? 0 }));
  });

  app.post('/api/rules', async (req, reply) => {
    const rule = saveRule(ctx, RuleInput.parse(req.body));
    publish(ctx, 'rule', rule);
    ctx.log.info({ rule_id: rule.id, name: rule.name }, 'rule created');
    return reply.code(201).send(rule);
  });

  app.put<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getRule(ctx, id)) return reply.code(404).send({ error: 'rule not found' });
    const rule = saveRule(ctx, RuleInput.parse(req.body), id);
    publish(ctx, 'rule', rule);
    ctx.log.info({ rule_id: id }, 'rule updated');
    return rule;
  });

  app.patch<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getRule(ctx, id);
    if (!existing) return reply.code(404).send({ error: 'rule not found' });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    ctx.db.prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, ctx.now(), id);
    invalidateRuleCache(ctx);
    const rule = getRule(ctx, id)!;
    publish(ctx, 'rule', rule);
    ctx.log.info({ rule_id: id, enabled }, 'rule toggled');
    return rule;
  });

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const used = (ctx.db.prepare('SELECT COUNT(*) n FROM incidents WHERE rule_id = ?').get(id) as { n: number }).n;
    if (used) return reply.code(409).send({ error: 'rule has incident history; disable it instead of deleting' });
    ctx.db.prepare('DELETE FROM rule_evaluations WHERE rule_id = ?').run(id);
    ctx.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    invalidateRuleCache(ctx);
    publish(ctx, 'rule', { id, deleted: true });
    return { ok: true };
  });

  /** Dry-run a rule against the last hour of real traffic before saving it. */
  app.post('/api/rules/preview', async (req) => {
    const input = RuleInput.parse(req.body);
    const rule = { ...input, id: 0, created_at: 0, updated_at: 0 };
    const devices = new Map((ctx.db.prepare('SELECT id, name, type, location, last_seen_at FROM devices').all() as any[]).map((d) => [d.id, d]));
    if (rule.kind === 'absence') {
      const cutoff = ctx.now() - rule.config.duration_sec * 1000;
      const silent = [...devices.values()].filter((d) => !inScope(rule, d) && (d.last_seen_at ?? 0) < cutoff);
      return { evaluated: devices.size, matched: silent.length, devices: silent.map((d) => ({ id: d.id, name: d.name, matches: 1 })), samples: [] };
    }
    const events = ctx.db
      .prepare('SELECT id, device_id, type, ts, payload FROM events WHERE ts > ? ORDER BY id DESC LIMIT 5000')
      .all(ctx.now() - 3600_000) as any[];
    const perDevice = new Map<string, number>();
    const samples: unknown[] = [];
    let evaluated = 0;
    for (const e of events) {
      const d = devices.get(e.device_id);
      if (!d) continue;
      const r = evaluate(rule, d, { type: e.type, payload: json(e.payload, {}) });
      if (r.outcome === 'not_applicable' || r.outcome === 'out_of_scope') continue;
      evaluated++;
      if (r.outcome === 'matched') {
        perDevice.set(e.device_id, (perDevice.get(e.device_id) ?? 0) + 1);
        if (samples.length < 8) samples.push({ event_pk: e.id, device_id: e.device_id, ts: e.ts, reason: r.reason });
      }
    }
    const matched = [...perDevice.values()].reduce((a, b) => a + b, 0);
    return {
      evaluated,
      matched,
      // Because of de-duplication, N matching events on a device produce at most one incident.
      estimated_incidents: perDevice.size,
      devices: [...perDevice.entries()].map(([id, matches]) => ({ id, name: devices.get(id)?.name, matches })),
      samples,
    };
  });

  app.get<{ Params: { id: string } }>('/api/rules/:id/evaluations', async (req) =>
    ctx.db.prepare('SELECT * FROM rule_evaluations WHERE rule_id = ? ORDER BY id DESC LIMIT 100').all(Number(req.params.id)),
  );

  app.get('/api/operators', async () =>
    (ctx.db.prepare('SELECT * FROM operators').all() as any[]).map((o) => ({ ...o, locations: json(o.locations, []) })),
  );

  // ---- Stats, activity, system -------------------------------------------
  app.get('/api/stats', async () => overview(ctx));
  app.get<{ Querystring: { minutes?: string } }>('/api/stats/timeseries', async (req) =>
    timeseries(ctx, Math.min(60, Number(req.query.minutes) || 15)),
  );

  app.get('/api/activity', async () => {
    const incidentRows = ctx.db
      .prepare(`SELECT t.at, t.kind, t.actor, t.detail, t.incident_id, i.title, i.severity, i.device_id
                FROM incident_timeline t JOIN incidents i ON i.id = t.incident_id ORDER BY t.id DESC LIMIT 60`)
      .all() as any[];
    const deviceRows = ctx.db.prepare('SELECT at, kind, detail, device_id FROM device_log ORDER BY id DESC LIMIT 60').all() as any[];
    return [
      ...incidentRows.map((r) => ({ ...r, source: 'incident' })),
      ...deviceRows.map((r) => ({ ...r, source: 'device' })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 80);
  });

  app.get('/api/system', async () => ({ ...systemHealth(ctx), stats: overview(ctx), stream_clients: hub.clients.size, change_cursor: hub.cursor }));

  app.post('/api/system/chaos', async (req) => {
    const chaos = setChaos(ctx, z.object({
      processingFailureRate: z.number().min(0).max(1).optional(),
      workerPaused: z.boolean().optional(),
      processingDelayMs: z.number().min(0).max(5000).optional(),
    }).parse(req.body));
    ctx.log.warn({ chaos }, 'fault injection settings changed');
    publish(ctx, 'system', { kind: 'chaos', chaos });
    return chaos;
  });

  // Thin proxies so the dashboard talks to one origin.
  const forward = async (reply: FastifyReply, url: string, init?: RequestInit) => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
      return reply.code(res.status).send(await res.json());
    } catch (e: any) {
      return reply.code(502).send({ error: `unreachable: ${url}`, detail: e.message });
    }
  };
  const notifierBase = ctx.config.notifier.url.replace(/\/notify$/, '');
  app.get('/api/notifier/inbox', (_req, reply) => forward(reply, `${notifierBase}/inbox`));
  app.post('/api/notifier/mode', (req, reply) =>
    forward(reply, `${notifierBase}/admin/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body) }),
  );
  app.all<{ Params: { '*': string } }>('/api/sim/*', (req, reply) =>
    forward(reply, `${ctx.config.simulatorUrl}/${req.params['*']}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
    }),
  );

  // ---- Live stream (SSE) -------------------------------------------------
  app.get<{ Querystring: { since?: string } }>('/api/stream', (req, reply) => {
    const header = req.headers['last-event-id'];
    const raw = (Array.isArray(header) ? header[0] : header) ?? req.query.since;
    const since = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    reply.raw.write('retry: 2000\n\n');
    const r = hub.attach(reply.raw, since);
    if (r.mode !== 'fresh') ctx.log.info({ since, ...r }, 'dashboard stream reconnected');
  });

  // ---- Static dashboard (production mode) --------------------------------
  const webDist = new URL('../../web/dist', import.meta.url).pathname;
  if (ctx.config.serveWeb && fs.existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
