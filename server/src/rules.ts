import { z } from 'zod';
import type { Ctx } from './context.js';
import { json } from './db.js';

// ---------------------------------------------------------------------------
// Rule model. Three kinds cover the brief; each is a small declarative config
// so operators can build them in the UI without writing code.
// ---------------------------------------------------------------------------

export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const Operator = z.enum(['>', '>=', '<', '<=', '==', '!=']);

export const ThresholdConfig = z.object({
  metric: z.string().min(1).max(64),
  operator: Operator,
  value: z.number(),
});
export const AbsenceConfig = z.object({ duration_sec: z.number().int().min(5).max(7 * 86400) });
export const EventTypeConfig = z.object({
  event_type: z.string().min(1).max(64),
  payload_match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const Scope = z
  .object({
    device_types: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    device_ids: z.array(z.string()).optional(),
  })
  .default({});

const base = {
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  severity: Severity.default('medium'),
  scope: Scope,
  /** After an incident is resolved, a new match within this window re-opens it instead of creating a new one. */
  cooldown_sec: z.number().int().min(0).max(86400).default(120),
  /** Resolve automatically when the condition clears (reading back in range / device reports again). */
  auto_resolve: z.boolean().default(false),
};

export const RuleInput = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('threshold'), config: ThresholdConfig }),
  z.object({ ...base, kind: z.literal('absence'), config: AbsenceConfig }),
  z.object({ ...base, kind: z.literal('event_type'), config: EventTypeConfig }),
]);
export type RuleInput = z.infer<typeof RuleInput>;

export type Rule = RuleInput & { id: number; created_at: number; updated_at: number };

export interface DeviceLite {
  id: string;
  type: string;
  location: string;
}

export interface EventLite {
  type: string;
  payload: Record<string, unknown>;
}

export type Evaluation =
  | { outcome: 'not_applicable' }
  | { outcome: 'out_of_scope'; reason: string }
  | { outcome: 'matched' | 'not_matched'; reason: string; value?: unknown };

// ---------------------------------------------------------------------------
// Pure evaluation - no I/O, trivially unit-testable.
// ---------------------------------------------------------------------------

export function inScope(rule: Pick<Rule, 'scope'>, device: DeviceLite): string | null {
  const s = rule.scope ?? {};
  if (s.device_ids?.length && !s.device_ids.includes(device.id)) return `device ${device.id} not in rule's device list`;
  if (s.device_types?.length && !s.device_types.includes(device.type))
    return `device type "${device.type}" not in scope [${s.device_types.join(', ')}]`;
  if (s.locations?.length && !s.locations.includes(device.location))
    return `location "${device.location}" not in scope [${s.locations.join(', ')}]`;
  return null;
}

const compare = (a: number, op: z.infer<typeof Operator>, b: number) =>
  op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : op === '==' ? a === b : a !== b;

export function evaluate(rule: Rule, device: DeviceLite, event: EventLite): Evaluation {
  if (rule.kind === 'absence') return { outcome: 'not_applicable' }; // evaluated by the scanner, not per event

  // Skip quickly when the event is irrelevant to this rule, so the decision log stays meaningful.
  if (rule.kind === 'threshold' && !(rule.config.metric in event.payload)) return { outcome: 'not_applicable' };
  if (rule.kind === 'event_type' && event.type !== rule.config.event_type) return { outcome: 'not_applicable' };

  const scopeMiss = inScope(rule, device);
  if (scopeMiss) return { outcome: 'out_of_scope', reason: scopeMiss };

  if (rule.kind === 'threshold') {
    const { metric, operator, value } = rule.config;
    const v = event.payload[metric];
    if (typeof v !== 'number' || !Number.isFinite(v))
      return { outcome: 'not_matched', reason: `${metric} is not numeric (${JSON.stringify(v)})` };
    const hit = compare(v, operator, value);
    return {
      outcome: hit ? 'matched' : 'not_matched',
      reason: hit ? `${metric} = ${v} ${operator} ${value}` : `${metric} = ${v}, not ${operator} ${value}`,
      value: v,
    };
  }

  // event_type
  const match = rule.config.payload_match ?? {};
  for (const [k, expected] of Object.entries(match)) {
    if (event.payload[k] !== expected)
      return { outcome: 'not_matched', reason: `type "${event.type}" but payload.${k} = ${JSON.stringify(event.payload[k])} ≠ ${JSON.stringify(expected)}` };
  }
  return { outcome: 'matched', reason: `event type "${event.type}" reported${Object.keys(match).length ? ' with matching payload' : ''}` };
}

export function describeRule(rule: RuleInput): string {
  if (rule.kind === 'threshold') return `${rule.config.metric} ${rule.config.operator} ${rule.config.value}`;
  if (rule.kind === 'absence') return `no data for ${rule.config.duration_sec}s`;
  return `event type = ${rule.config.event_type}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function rowToRule(r: any): Rule {
  return {
    ...r,
    enabled: !!r.enabled,
    auto_resolve: !!r.auto_resolve,
    config: json(r.config, {}),
    scope: json(r.scope, {}),
  };
}

const caches = new WeakMap<object, { at: number; rules: Rule[] }>();

/** Enabled rules, cached briefly so the hot path does not re-read them for every event. */
export function enabledRules(ctx: Ctx, maxAgeMs = 1000): Rule[] {
  const now = ctx.now();
  const cache = caches.get(ctx.db);
  if (cache && now - cache.at <= maxAgeMs && now >= cache.at) return cache.rules;
  const rules = (ctx.db.prepare('SELECT * FROM rules WHERE enabled = 1').all() as any[]).map(rowToRule);
  caches.set(ctx.db, { at: now, rules });
  return rules;
}

export function invalidateRuleCache(ctx: Ctx) {
  caches.delete(ctx.db);
}

export function listRules(ctx: Ctx) {
  return (ctx.db.prepare('SELECT * FROM rules ORDER BY id').all() as any[]).map(rowToRule);
}

export function getRule(ctx: Ctx, id: number): Rule | undefined {
  const r = ctx.db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  return r ? rowToRule(r) : undefined;
}

export function saveRule(ctx: Ctx, input: RuleInput, id?: number): Rule {
  const now = ctx.now();
  const params = {
    name: input.name,
    kind: input.kind,
    enabled: input.enabled ? 1 : 0,
    severity: input.severity,
    config: JSON.stringify(input.config),
    scope: JSON.stringify(input.scope ?? {}),
    cooldown_sec: input.cooldown_sec,
    auto_resolve: input.auto_resolve ? 1 : 0,
    now,
  };
  let ruleId = id;
  if (id) {
    ctx.db
      .prepare(
        `UPDATE rules SET name=@name, kind=@kind, enabled=@enabled, severity=@severity, config=@config, scope=@scope,
           cooldown_sec=@cooldown_sec, auto_resolve=@auto_resolve, updated_at=@now WHERE id=@id`,
      )
      .run({ ...params, id });
  } else {
    ruleId = Number(
      ctx.db
        .prepare(
          `INSERT INTO rules (name, kind, enabled, severity, config, scope, cooldown_sec, auto_resolve, created_at, updated_at)
           VALUES (@name, @kind, @enabled, @severity, @config, @scope, @cooldown_sec, @auto_resolve, @now, @now)`,
        )
        .run(params).lastInsertRowid,
    );
  }
  invalidateRuleCache(ctx);
  return getRule(ctx, ruleId!)!;
}
