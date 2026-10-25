import type { Ctx } from './context.js';
import { json } from './db.js';
import { publish } from './changes.js';
import { SEVERITY_RANK, describeRule, getRule, type Rule, type Severity } from './rules.js';

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface TriggerEvent {
  pk: number;
  ts: number;
  late: boolean;
  received_at: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: string;
  location: string;
}

export type TriggerOutcome =
  | { kind: 'created'; incidentId: number }
  | { kind: 'linked'; incidentId: number }
  | { kind: 'reopened'; incidentId: number };

const dedupKey = (ruleId: number, deviceId: string) => `${ruleId}:${deviceId}`;

export function timeline(ctx: Ctx, incidentId: number, kind: string, actor: string, detail: string) {
  ctx.db
    .prepare('INSERT INTO incident_timeline (incident_id, at, kind, actor, detail) VALUES (?, ?, ?, ?, ?)')
    .run(incidentId, ctx.now(), kind, actor, detail);
}

export function incidentRow(ctx: Ctx, id: number) {
  return ctx.db
    .prepare(
      `SELECT i.*, r.name AS rule_name, r.kind AS rule_kind, d.name AS device_name, d.location, d.type AS device_type,
              (SELECT COUNT(*) FROM incident_events ie WHERE ie.incident_id = i.id) AS event_count
       FROM incidents i JOIN rules r ON r.id = i.rule_id JOIN devices d ON d.id = i.device_id WHERE i.id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
}

function emit(ctx: Ctx, id: number) {
  publish(ctx, 'incident', incidentRow(ctx, id));
}

/**
 * Called inside the event-processing transaction when a rule matches.
 *
 * De-duplication policy (keyed on rule + device):
 *  1. An unresolved incident exists      -> link the event to it, bump trigger_count. No new notification.
 *  2. Resolved less than cooldown ago    -> re-open it (flapping protection), notify again.
 *  3. Otherwise                          -> open a new incident and notify the routed operators.
 * The partial unique index `incidents_one_active` makes (1) safe even with concurrent workers.
 */
export function trigger(
  ctx: Ctx,
  rule: Rule,
  device: DeviceInfo,
  reason: string,
  event: TriggerEvent | null,
): TriggerOutcome {
  const now = ctx.now();
  const key = dedupKey(rule.id, device.id);
  const latest = ctx.db
    .prepare('SELECT id, status, resolved_at, condition_active FROM incidents WHERE dedup_key = ? ORDER BY id DESC LIMIT 1')
    .get(key) as { id: number; status: IncidentStatus; resolved_at: number | null; condition_active: number } | undefined;

  const link = (incidentId: number) =>
    event
      ? ctx.db
          .prepare('INSERT OR IGNORE INTO incident_events (incident_id, event_pk, linked_at) VALUES (?, ?, ?)')
          .run(incidentId, event.pk, now).changes > 0
      : true;

  if (latest && latest.status !== 'resolved') {
    const linked = link(latest.id);
    if (linked) {
      ctx.db
        .prepare(
          `UPDATE incidents SET trigger_count = trigger_count + 1, last_triggered_at = ?, condition_active = 1,
             last_event_ts = MAX(COALESCE(last_event_ts, 0), ?), version = version + 1 WHERE id = ?`,
        )
        .run(now, event?.ts ?? 0, latest.id);
      if (!latest.condition_active) timeline(ctx, latest.id, 'retriggered', 'system', `Condition returned: ${reason}`);
      emit(ctx, latest.id);
    }
    return { kind: 'linked', incidentId: latest.id };
  }

  if (latest && latest.resolved_at && now - latest.resolved_at < rule.cooldown_sec * 1000) {
    link(latest.id);
    ctx.db
      .prepare(
        `UPDATE incidents SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution_note = NULL,
           acknowledged_at = NULL, acknowledged_by = NULL, condition_active = 1, trigger_count = trigger_count + 1,
           last_triggered_at = ?, last_event_ts = MAX(COALESCE(last_event_ts, 0), ?), version = version + 1 WHERE id = ?`,
      )
      .run(now, event?.ts ?? 0, latest.id);
    timeline(ctx, latest.id, 'reopened', 'system', `Re-opened within ${rule.cooldown_sec}s cooldown: ${reason}`);
    enqueueNotifications(ctx, latest.id, 'reopened');
    emit(ctx, latest.id);
    ctx.log.info({ incident_id: latest.id, rule_id: rule.id, device_id: device.id }, 'incident re-opened');
    return { kind: 'reopened', incidentId: latest.id };
  }

  const late = event?.late ?? false;
  const title = `${rule.name} — ${device.name}`;
  const summary =
    `${reason} (rule: ${describeRule(rule)}).` +
    (late && event
      ? ` Detected late: happened ${new Date(event.ts).toISOString()}, delivered ${Math.round((event.received_at - event.ts) / 1000)}s later after the device reconnected.`
      : '');
  const id = Number(
    ctx.db
      .prepare(
        `INSERT INTO incidents (rule_id, device_id, dedup_key, status, severity, title, summary, opened_at,
           last_triggered_at, last_event_ts, detected_late)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rule.id, device.id, key, rule.severity, title, summary, now, now, event?.ts ?? null, late ? 1 : 0)
      .lastInsertRowid,
  );
  link(id);
  timeline(ctx, id, 'opened', 'system', summary);
  enqueueNotifications(ctx, id, 'opened');
  emit(ctx, id);
  ctx.log.info({ incident_id: id, rule_id: rule.id, device_id: device.id, severity: rule.severity, late }, `incident opened: ${title}`);
  return { kind: 'created', incidentId: id };
}

/**
 * A reading for a threshold rule came back in range. Only applies if the reading is newer than
 * the one that triggered the incident - an old, replayed "normal" reading must not clear a
 * newer breach (out-of-order safety).
 */
export function conditionCleared(ctx: Ctx, rule: Rule, deviceId: string, eventTs: number, reason: string) {
  const inc = ctx.db
    .prepare(`SELECT id, condition_active, last_event_ts FROM incidents WHERE dedup_key = ? AND status != 'resolved'`)
    .get(dedupKey(rule.id, deviceId)) as { id: number; condition_active: number; last_event_ts: number | null } | undefined;
  if (!inc || !inc.condition_active) return null;
  if (inc.last_event_ts !== null && eventTs <= inc.last_event_ts) return null;

  ctx.db.prepare('UPDATE incidents SET condition_active = 0, version = version + 1 WHERE id = ?').run(inc.id);
  if (rule.auto_resolve) {
    resolve(ctx, inc.id, 'system', `Auto-resolved: ${reason}`, true);
  } else {
    timeline(ctx, inc.id, 'condition_cleared', 'system', `Condition cleared (${reason}); awaiting operator`);
    emit(ctx, inc.id);
  }
  return inc.id;
}

/** Device made contact again: close "stopped reporting" incidents whose rule allows auto-resolve. */
export function resolveAbsenceOnContact(ctx: Ctx, deviceId: string, offlineForMs: number | null, replayed: number) {
  const rows = ctx.db
    .prepare(
      `SELECT i.id, r.auto_resolve FROM incidents i JOIN rules r ON r.id = i.rule_id
       WHERE i.device_id = ? AND r.kind = 'absence' AND i.status != 'resolved'`,
    )
    .all(deviceId) as { id: number; auto_resolve: number }[];
  for (const row of rows) {
    const note =
      `Device reconnected after ${offlineForMs ? Math.round(offlineForMs / 1000) + 's' : 'an unknown period'}` +
      (replayed ? `, replaying ${replayed}+ buffered event(s)` : '');
    ctx.db.prepare('UPDATE incidents SET condition_active = 0, version = version + 1 WHERE id = ?').run(row.id);
    if (row.auto_resolve) resolve(ctx, row.id, 'system', `Auto-resolved: ${note}`, true);
    else {
      timeline(ctx, row.id, 'condition_cleared', 'system', note);
      emit(ctx, row.id);
    }
  }
}

export class TransitionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function acknowledge(ctx: Ctx, id: number, actor: string, expectedVersion?: number) {
  const inc = ctx.db.prepare('SELECT status, version FROM incidents WHERE id = ?').get(id) as
    | { status: IncidentStatus; version: number }
    | undefined;
  if (!inc) throw new TransitionError(404, 'incident not found');
  if (expectedVersion !== undefined && inc.version !== expectedVersion)
    throw new TransitionError(409, 'incident changed since you loaded it; refresh and retry');
  if (inc.status !== 'open') throw new TransitionError(409, `cannot acknowledge an incident that is ${inc.status}`);
  ctx.db
    .prepare(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, assignee = COALESCE(assignee, ?), version = version + 1 WHERE id = ?`)
    .run(ctx.now(), actor, actor, id);
  timeline(ctx, id, 'acknowledged', actor, `Acknowledged by ${actor}`);
  emit(ctx, id);
  ctx.log.info({ incident_id: id, actor }, 'incident acknowledged');
  return incidentRow(ctx, id);
}

export function resolve(ctx: Ctx, id: number, actor: string, note: string, auto = false, expectedVersion?: number) {
  const inc = ctx.db.prepare('SELECT status, version FROM incidents WHERE id = ?').get(id) as
    | { status: IncidentStatus; version: number }
    | undefined;
  if (!inc) throw new TransitionError(404, 'incident not found');
  if (expectedVersion !== undefined && inc.version !== expectedVersion)
    throw new TransitionError(409, 'incident changed since you loaded it; refresh and retry');
  if (inc.status === 'resolved') throw new TransitionError(409, 'incident is already resolved');
  ctx.db
    .prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?, version = version + 1 WHERE id = ?`)
    .run(ctx.now(), actor, note || null, id);
  timeline(ctx, id, auto ? 'auto_resolved' : 'resolved', actor, note || `Resolved by ${actor}`);
  emit(ctx, id);
  ctx.log.info({ incident_id: id, actor, auto }, 'incident resolved');
  return incidentRow(ctx, id);
}

// ---------------------------------------------------------------------------
// Notification routing -> transactional outbox
// ---------------------------------------------------------------------------

/**
 * "Notify the appropriate operator": operators subscribe to locations and a minimum severity.
 * Rows are written to the outbox in the SAME transaction as the incident change, so a crash can
 * never produce an incident without its notification (or vice versa). Delivery is async.
 */
export function enqueueNotifications(ctx: Ctx, incidentId: number, kind: 'opened' | 'reopened') {
  const inc = incidentRow(ctx, incidentId)!;
  const ops = ctx.db.prepare('SELECT id, name, email, locations, min_severity FROM operators').all() as any[];
  const targets = ops.filter((o) => {
    const locs: string[] = json(o.locations, []);
    return (locs.includes('*') || locs.includes(inc.location)) && SEVERITY_RANK[inc.severity as Severity] >= SEVERITY_RANK[o.min_severity as Severity];
  });
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO notifications (incident_id, operator_id, kind, idempotency_key, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const op of targets) {
    const payload = {
      to: { id: op.id, name: op.name, email: op.email },
      subject: `[${String(inc.severity).toUpperCase()}] ${kind === 'reopened' ? 'Re-opened: ' : ''}${inc.title}`,
      body: inc.summary,
      incident_id: incidentId,
      device_id: inc.device_id,
      location: inc.location,
      link: `/incidents/${incidentId}`,
    };
    insert.run(incidentId, op.id, kind, `inc-${incidentId}-v${inc.version}-${kind}-${op.id}`, JSON.stringify(payload), ctx.now());
  }
  if (targets.length === 0) {
    timeline(ctx, incidentId, 'routing', 'system', `No operator subscribed to ${inc.location} at ${inc.severity} severity`);
    ctx.log.warn({ incident_id: incidentId, location: inc.location }, 'no operator routed for incident');
  }
  if (targets.length) {
    ctx.db
      .prepare('UPDATE incidents SET assignee = COALESCE(assignee, ?) WHERE id = ?')
      .run(targets.find((t) => !json<string[]>(t.locations, []).includes('*'))?.name ?? targets[0].name, incidentId);
  }
}

export function incidentDetail(ctx: Ctx, id: number) {
  const inc = incidentRow(ctx, id);
  if (!inc) return undefined;
  const events = ctx.db
    .prepare(
      `SELECT e.id, e.event_id, e.seq, e.type, e.ts, e.received_at, e.payload, e.late, e.out_of_order, e.status
       FROM incident_events ie JOIN events e ON e.id = ie.event_pk WHERE ie.incident_id = ? ORDER BY e.ts DESC LIMIT 200`,
    )
    .all(id)
    .map((e: any) => ({ ...e, payload: json(e.payload, {}), late: !!e.late, out_of_order: !!e.out_of_order }));
  const timelineRows = ctx.db.prepare('SELECT * FROM incident_timeline WHERE incident_id = ? ORDER BY at, id').all(id);
  const notifications = ctx.db
    .prepare('SELECT id, operator_id, kind, status, attempts, last_error, created_at, sent_at, payload FROM notifications WHERE incident_id = ? ORDER BY id')
    .all(id)
    .map((n: any) => ({ ...n, payload: json(n.payload, {}) }));
  const rule = getRule(ctx, inc.rule_id);
  return { ...inc, rule, events, timeline: timelineRows, notifications };
}
