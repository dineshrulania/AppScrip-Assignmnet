import type { Ctx } from './context.js';
import { saveRule, type RuleInput } from './rules.js';

export const SEED_RULES: RuleInput[] = [
  { name: 'Cold-chain temperature breach', kind: 'threshold', enabled: true, severity: 'critical',
    config: { metric: 'temperature', operator: '>', value: 8 }, scope: { device_types: ['cold_storage'] }, cooldown_sec: 120, auto_resolve: false },
  { name: 'Server room overheating', kind: 'threshold', enabled: true, severity: 'high',
    config: { metric: 'temperature', operator: '>', value: 30 }, scope: { device_types: ['hvac'] }, cooldown_sec: 120, auto_resolve: false },
  { name: 'Generator coolant overheating', kind: 'threshold', enabled: true, severity: 'high',
    config: { metric: 'temperature', operator: '>', value: 95 }, scope: { device_types: ['generator'] }, cooldown_sec: 120, auto_resolve: false },
  { name: 'Device stopped reporting', kind: 'absence', enabled: true, severity: 'high',
    config: { duration_sec: 30 }, scope: {}, cooldown_sec: 60, auto_resolve: true },
  { name: 'Hardware fault reported', kind: 'event_type', enabled: true, severity: 'critical',
    config: { event_type: 'fault' }, scope: {}, cooldown_sec: 300, auto_resolve: false },
  { name: 'Tamper detected', kind: 'event_type', enabled: true, severity: 'high',
    config: { event_type: 'tamper' }, scope: {}, cooldown_sec: 300, auto_resolve: false },
  { name: 'Battery critically low', kind: 'threshold', enabled: true, severity: 'low',
    config: { metric: 'battery', operator: '<', value: 15 }, scope: {}, cooldown_sec: 600, auto_resolve: true },
];

export const SEED_OPERATORS = [
  { id: 'op-sara', name: 'Sara Mitchell', email: 'sara.mitchell@ops.example', locations: ['North Warehouse', 'East Port'], min_severity: 'low' },
  { id: 'op-james', name: 'James Okafor', email: 'james.okafor@ops.example', locations: ['Central DC', 'South Hub'], min_severity: 'low' },
  { id: 'op-noc', name: 'NOC On-call', email: 'noc@ops.example', locations: ['*'], min_severity: 'critical' },
];

/** Idempotent and atomic: api and worker may both start against an empty database. */
export function seed(ctx: Ctx) {
  ctx.db.transaction(() => seedTx(ctx)).immediate();
}

function seedTx(ctx: Ctx) {
  const hasRules = (ctx.db.prepare('SELECT COUNT(*) n FROM rules').get() as { n: number }).n > 0;
  if (!hasRules) for (const r of SEED_RULES) saveRule(ctx, r);
  const op = ctx.db.prepare('INSERT OR IGNORE INTO operators (id, name, email, locations, min_severity) VALUES (?, ?, ?, ?, ?)');
  for (const o of SEED_OPERATORS) op.run(o.id, o.name, o.email, JSON.stringify(o.locations), o.min_severity);
  if (!hasRules) ctx.log.info(`seeded ${SEED_RULES.length} rules and ${SEED_OPERATORS.length} operators`);
}
