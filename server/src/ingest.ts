import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './context.js';
import { tx } from './db.js';
import { publish } from './changes.js';
import { resolveAbsenceOnContact } from './incidents.js';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

const timestamp = z.union([
  z.number().int().positive(),
  z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 timestamp'),
]);

const metricValue = z.number().refine(Number.isFinite, 'must be a finite number');

export const EventSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    seq: z.number().int().nonnegative().optional(),
    boot_id: z.string().max(64).optional(),
    device_id: z.string().optional(), // optional; if present it must match the authenticated device
    type: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'lowercase identifier, e.g. "telemetry"'),
    ts: timestamp,
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((ev, ctx) => {
    if (ev.type === 'telemetry') {
      const entries = Object.entries(ev.payload);
      if (entries.length === 0) ctx.addIssue({ code: 'custom', path: ['payload'], message: 'telemetry needs at least one metric' });
      for (const [k, v] of entries) {
        if (!metricValue.safeParse(v).success)
          ctx.addIssue({ code: 'custom', path: ['payload', k], message: `metric "${k}" must be a finite number` });
      }
    }
    if (JSON.stringify(ev.payload).length > 16_384)
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'payload exceeds 16KB' });
  });

export type WireEvent = z.infer<typeof EventSchema>;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; event_id?: string; errors: string[] }[];
  /**
   * Per-event outcome, same order as the request. Every outcome is final, so the device drops
   * all of them from its buffer; only a non-2xx response (429/5xx/network) means "retry the batch".
   */
  results: ('accepted' | 'duplicate' | 'rejected')[];
}

export class IngestError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export function registerDevice(
  ctx: Ctx,
  input: { device_id: string; name?: string; location: string; type: string },
): { device_id: string; device_key: string } {
  const key = `dk_${crypto.randomBytes(24).toString('base64url')}`;
  ctx.db
    .prepare(
      `INSERT INTO devices (id, name, location, type, key_hash, created_at)
       VALUES (@id, @name, @location, @type, @key_hash, @now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, location = excluded.location,
         type = excluded.type, key_hash = excluded.key_hash`,
    )
    .run({
      id: input.device_id,
      name: input.name ?? input.device_id,
      location: input.location,
      type: input.type,
      key_hash: hashKey(key),
      now: ctx.now(),
    });
  publish(ctx, 'device', deviceRow(ctx, input.device_id));
  ctx.log.info({ device_id: input.device_id }, 'device registered (key issued)');
  return { device_id: input.device_id, device_key: key };
}

export function authenticateDevice(ctx: Ctx, authHeader: string | undefined) {
  const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
  if (!key) throw new IngestError(401, 'missing device key (Authorization: Bearer <device_key>)');
  const device = ctx.db.prepare('SELECT id, status, last_seen_at FROM devices WHERE key_hash = ?').get(hashKey(key)) as
    | { id: string; status: string; last_seen_at: number | null }
    | undefined;
  if (!device) throw new IngestError(401, 'unknown or revoked device key');
  return device;
}

export function deviceRow(ctx: Ctx, id: string) {
  const d = ctx.db
    .prepare(
      `SELECT id, name, location, type, created_at, last_seen_at, last_event_ts, last_seq, boot_id, status,
              status_since, latest, events_total, duplicates_total, late_total FROM devices WHERE id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
  if (d) d.latest = JSON.parse(d.latest);
  return d;
}

export function logDevice(ctx: Ctx, deviceId: string, kind: string, detail: string) {
  ctx.db.prepare('INSERT INTO device_log (device_id, at, kind, detail) VALUES (?, ?, ?, ?)').run(deviceId, ctx.now(), kind, detail);
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

const depthCaches = new WeakMap<object, { at: number; value: number }>();

/** Queue depth, cached for a moment so a burst of requests doesn't COUNT(*) on every call. */
export function queueDepth(ctx: Ctx, maxAgeMs = 250): number {
  const now = ctx.now();
  const cached = depthCaches.get(ctx.db);
  if (cached && now - cached.at <= maxAgeMs && now >= cached.at) return cached.value;
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE status IN ('pending', 'processing')")
    .get() as { n: number };
  depthCaches.set(ctx.db, { at: now, value: row.n });
  return row.n;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** How many events from one request are streamed individually to dashboards; the rest are summarised. */
const STREAM_EVENTS_PER_BATCH = 40;

export function ingest(ctx: Ctx, deviceId: string, body: unknown): IngestResult {
  const raw = Array.isArray(body) ? body : (body as any)?.events ?? (body && typeof body === 'object' ? [body] : null);
  if (!Array.isArray(raw)) throw new IngestError(400, 'body must be an event, an array of events, or {"events": [...]}');
  if (raw.length === 0) return { accepted: 0, duplicates: 0, rejected: [], results: [] };
  if (raw.length > ctx.config.ingest.maxBatch)
    throw new IngestError(413, `batch too large (${raw.length} > ${ctx.config.ingest.maxBatch}); split it`);

  const depth = queueDepth(ctx);
  if (depth >= ctx.config.ingest.highWatermark) {
    ctx.log.warn({ depth, device_id: deviceId }, 'backpressure: queue above high watermark, asking device to retry');
    throw new IngestError(429, `processing backlog is ${depth} events; retry later`, 2);
  }

  const now = ctx.now();
  const { lateAfterMs, maxFutureSkewMs, maxAgeMs } = ctx.config.ingest;
  const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [], results: [] };

  type Valid = { index: number; ev: WireEvent; ts: number };
  const valid: Valid[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = EventSchema.safeParse(raw[i]);
    let errors: string[] = [];
    let ts = 0;
    if (!parsed.success) {
      errors = parsed.error.issues.map((iss) => `${iss.path.join('.') || '(event)'}: ${iss.message}`);
    } else {
      ts = typeof parsed.data.ts === 'number' ? parsed.data.ts : Date.parse(parsed.data.ts);
      if (parsed.data.device_id && parsed.data.device_id !== deviceId)
        errors.push(`device_id "${parsed.data.device_id}" does not match the authenticated device`);
      if (ts > now + maxFutureSkewMs) errors.push(`ts is ${Math.round((ts - now) / 1000)}s in the future (clock skew)`);
      if (ts < now - maxAgeMs) errors.push('ts is older than the retention window');
    }
    if (errors.length) {
      result.rejected.push({ index: i, event_id: (raw[i] as any)?.event_id, errors });
      result.results[i] = 'rejected';
    } else {
      valid.push({ index: i, ev: parsed.data!, ts });
    }
  }

  const insert = ctx.db.prepare(
    `INSERT INTO events (device_id, event_id, seq, type, ts, received_at, payload, late, out_of_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, event_id) DO NOTHING`,
  );
  const rejectStmt = ctx.db.prepare(
    'INSERT INTO rejected_events (received_at, device_id, reason, raw) VALUES (?, ?, ?, ?)',
  );

  const streamed: unknown[] = [];
  let late = 0;

  tx(ctx.db, () => {
    const before = ctx.db
      .prepare('SELECT status, last_seen_at, boot_id FROM devices WHERE id = ?')
      .get(deviceId) as { status: string; last_seen_at: number | null; boot_id: string | null };
    const maxRow = ctx.db.prepare('SELECT MAX(ts) AS ts FROM events WHERE device_id = ?').get(deviceId) as { ts: number | null };
    let maxTs = maxRow.ts ?? 0;
    let bootId: string | null = before.boot_id;

    for (const { index, ev, ts } of valid) {
      const isLate = now - ts > lateAfterMs;
      const outOfOrder = ts < maxTs;
      const info = insert.run(deviceId, ev.event_id, ev.seq ?? null, ev.type, ts, now, JSON.stringify(ev.payload), isLate ? 1 : 0, outOfOrder ? 1 : 0);
      if (info.changes === 0) {
        result.duplicates++;
        result.results[index] = 'duplicate';
        continue;
      }
      result.accepted++;
      result.results[index] = 'accepted';
      if (isLate) late++;
      maxTs = Math.max(maxTs, ts);
      if (ev.boot_id) bootId = ev.boot_id;
      if (streamed.length < STREAM_EVENTS_PER_BATCH)
        streamed.push({
          id: Number(info.lastInsertRowid), device_id: deviceId, event_id: ev.event_id, seq: ev.seq ?? null,
          type: ev.type, ts, received_at: now, payload: ev.payload, late: isLate, out_of_order: outOfOrder, status: 'pending',
        });
    }

    for (const r of result.rejected) {
      rejectStmt.run(now, deviceId, r.errors.join('; '), JSON.stringify(raw[r.index] ?? null).slice(0, 4000));
    }

    // Liveness is recorded at *ingest* time, so a slow or paused worker never makes healthy
    // devices look silent. Any authenticated contact (even duplicates) proves the device is alive.
    const wasOffline = before.status !== 'online';
    const rebooted = before.boot_id !== null && bootId !== before.boot_id;
    ctx.db
      .prepare(
        `UPDATE devices SET last_seen_at = @now, status = 'online',
           status_since = CASE WHEN status = 'online' THEN status_since ELSE @now END,
           boot_id = @boot, events_total = events_total + @acc,
           duplicates_total = duplicates_total + @dup, late_total = late_total + @late
         WHERE id = @id`,
      )
      .run({ now, boot: bootId, acc: result.accepted, dup: result.duplicates, late, id: deviceId });

    ctx.db
      .prepare(
        `INSERT INTO ingest_stats (bucket, accepted, duplicates, rejected, late) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET accepted = accepted + excluded.accepted,
           duplicates = duplicates + excluded.duplicates, rejected = rejected + excluded.rejected, late = late + excluded.late`,
      )
      .run(Math.floor(now / 1000), result.accepted, result.duplicates, result.rejected.length, late);

    if (wasOffline) {
      const offlineFor = before.last_seen_at ? now - before.last_seen_at : null;
      ctx.log.info({ device_id: deviceId, offline_ms: offlineFor, replayed: late }, before.last_seen_at ? 'device reconnected' : 'device first contact');
      logDevice(ctx, deviceId, 'online',
        before.last_seen_at ? `Reconnected after ${Math.round((offlineFor ?? 0) / 1000)}s${late ? `, replaying ${late} buffered event(s)` : ''}` : 'First contact');
      resolveAbsenceOnContact(ctx, deviceId, offlineFor, late);
    }
    if (rebooted) {
      ctx.log.info({ device_id: deviceId, boot_id: bootId }, 'device reboot detected (new boot_id)');
      logDevice(ctx, deviceId, 'reboot', `New boot id ${bootId}; sequence numbers restart`);
    }

    for (const e of streamed) publish(ctx, 'event', e);
    if (result.accepted > streamed.length)
      publish(ctx, 'system', { kind: 'burst', device_id: deviceId, accepted: result.accepted, late });
    if (wasOffline || result.accepted || result.duplicates) publish(ctx, 'device', deviceRow(ctx, deviceId));
  });

  if (result.rejected.length)
    ctx.log.warn({ device_id: deviceId, rejected: result.rejected.slice(0, 5) }, `rejected ${result.rejected.length} malformed event(s)`);
  if (result.duplicates)
    ctx.log.debug({ device_id: deviceId, duplicates: result.duplicates }, 'duplicate events ignored (idempotent)');

  return result;
}
