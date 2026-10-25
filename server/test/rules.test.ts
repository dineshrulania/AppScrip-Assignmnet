import { describe, expect, it } from 'vitest';
import { RuleInput, evaluate, inScope, type Rule } from '../src/rules.js';

const rule = (input: unknown): Rule => ({ ...RuleInput.parse(input), id: 1, created_at: 0, updated_at: 0 });
const cold = { id: 'cs-1', type: 'cold_storage', location: 'North Warehouse' };

describe('rule evaluation (pure)', () => {
  const tempRule = rule({ name: 't', kind: 'threshold', config: { metric: 'temperature', operator: '>', value: 8 }, scope: { device_types: ['cold_storage'] } });

  it('matches a threshold breach and explains why', () => {
    const r = evaluate(tempRule, cold, { type: 'telemetry', payload: { temperature: 9.1 } });
    expect(r).toMatchObject({ outcome: 'matched', reason: 'temperature = 9.1 > 8' });
  });

  it('does not match an in-range reading, and says so', () => {
    expect(evaluate(tempRule, cold, { type: 'telemetry', payload: { temperature: 4 } })).toMatchObject({
      outcome: 'not_matched',
      reason: 'temperature = 4, not > 8',
    });
  });

  it('ignores events that do not carry the metric', () => {
    expect(evaluate(tempRule, cold, { type: 'telemetry', payload: { humidity: 50 } }).outcome).toBe('not_applicable');
  });

  it('reports out-of-scope devices explicitly (decision log)', () => {
    const r = evaluate(tempRule, { ...cold, type: 'hvac' }, { type: 'telemetry', payload: { temperature: 40 } });
    expect(r).toMatchObject({ outcome: 'out_of_scope' });
    expect(inScope(tempRule, cold)).toBeNull();
  });

  it('event_type rules optionally match payload fields', () => {
    const r = rule({ name: 'f', kind: 'event_type', config: { event_type: 'fault', payload_match: { code: 'E1' } } });
    expect(evaluate(r, cold, { type: 'fault', payload: { code: 'E1' } }).outcome).toBe('matched');
    expect(evaluate(r, cold, { type: 'fault', payload: { code: 'E2' } }).outcome).toBe('not_matched');
    expect(evaluate(r, cold, { type: 'boot', payload: {} }).outcome).toBe('not_applicable');
  });

  it('rejects invalid rule definitions', () => {
    expect(RuleInput.safeParse({ name: 'x', kind: 'threshold', config: { metric: 'temperature', operator: '~', value: 1 } }).success).toBe(false);
    expect(RuleInput.safeParse({ name: 'x', kind: 'absence', config: { duration_sec: 1 } }).success).toBe(false);
  });
});
