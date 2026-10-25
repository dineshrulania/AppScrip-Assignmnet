import { useEffect, useMemo, useState } from 'react';
import { refreshRules, useStore } from '../store';
import { api } from '../api';
import { Ago, Badge, Drawer, Icon, Seg, SevBadge, Toggle, fmt, useAction } from '../components/ui';
import { describe } from './Incidents';
import type { Rule, Severity } from '../types';

const KIND_INFO = {
  threshold: { label: 'Threshold', icon: 'thermo', help: 'Fires when a numeric reading crosses a limit.' },
  absence: { label: 'Stopped reporting', icon: 'wifiOff', help: 'Fires when a device sends nothing for a while (server clock, so device clock drift is irrelevant).' },
  event_type: { label: 'Event type', icon: 'zap', help: 'Fires when a device reports a specific kind of event.' },
} as const;

export default function Rules() {
  const rules = useStore((s) => s.rules);
  const conn = useStore((s) => s.conn);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [busy, run] = useAction();

  return (
    <>
      <div className="flex">
        <div className="text-2 small">Rules are evaluated for every event by the worker; time-based rules run on a scanner every 2s. Repeated matches are folded into one incident per rule + device.</div>
        <button className="btn primary right" onClick={() => setEditing('new')} disabled={conn !== 'live'}><Icon name="plus" size={14} /> New rule</button>
      </div>
      <div className="grid g-3">
        {rules.map((r) => {
          const k = KIND_INFO[r.kind];
          return (
            <section key={r.id} className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, opacity: r.enabled ? 1 : 0.6 }}>
              <div className="flex">
                <div className="health-icon" style={{ width: 30, height: 30, background: 'var(--accent-soft)' }}><Icon name={k.icon} size={15} color="var(--accent-2)" /></div>
                <div className="grow">
                  <div className="b600 ellipsis">{r.name}</div>
                  <div className="muted small">{k.label}</div>
                </div>
                <Toggle on={r.enabled} disabled={busy || conn !== 'live'} title={r.enabled ? 'Disable' : 'Enable'}
                  onChange={(v) => run(async () => { await api.patch(`/api/rules/${r.id}`, { enabled: v }); await refreshRules(); }, `${r.name} ${v ? 'enabled' : 'disabled'}`)} />
              </div>
              <code style={{ background: 'var(--bg-2)', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)' }}>{describe(r)}</code>
              <div className="flex wrap" style={{ gap: 6 }}>
                <SevBadge s={r.severity} />
                <Badge tone="outline">{scopeText(r)}</Badge>
                {r.auto_resolve && <Badge tone="ok">auto-resolve</Badge>}
                <Badge tone="outline">cooldown {r.cooldown_sec}s</Badge>
              </div>
              <div className="flex small muted" style={{ marginTop: 'auto' }}>
                <span><b className="text-2">{fmt(r.matches_1h)}</b> matches/1h</span>·
                <span><b className="text-2">{r.active_incidents ?? 0}</b> active</span>·
                <span>last <Ago ts={r.last_match} /></span>
                <button className="btn sm ghost right" onClick={() => setEditing(r)} disabled={conn !== 'live'}>Edit</button>
              </div>
            </section>
          );
        })}
      </div>
      {editing && <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const scopeText = (r: Rule) => {
  const parts = [...(r.scope.device_types ?? []), ...(r.scope.locations ?? []), ...(r.scope.device_ids ?? [])];
  return parts.length ? parts.join(', ').replace(/_/g, ' ') : 'all devices';
};

interface Preview {
  evaluated: number;
  matched: number;
  estimated_incidents?: number;
  devices: { id: string; name?: string; matches: number }[];
  samples: { device_id: string; ts: number; reason: string }[];
}

function RuleEditor({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const devices = useStore((s) => s.devices);
  const types = useMemo(() => Array.from(new Set(Object.values(devices).map((d) => d.type))).sort(), [devices]);
  const locations = useMemo(() => Array.from(new Set(Object.values(devices).map((d) => d.location))).sort(), [devices]);
  const [busy, run] = useAction();

  const [name, setName] = useState(rule?.name ?? '');
  const [kind, setKind] = useState<Rule['kind']>(rule?.kind ?? 'threshold');
  const [severity, setSeverity] = useState<Severity>(rule?.severity ?? 'medium');
  const [metric, setMetric] = useState(rule?.kind === 'threshold' ? rule.config.metric : 'temperature');
  const [op, setOp] = useState(rule?.kind === 'threshold' ? rule.config.operator : '>');
  const [value, setValue] = useState(String(rule?.kind === 'threshold' ? rule.config.value : 30));
  const [duration, setDuration] = useState(String(rule?.kind === 'absence' ? rule.config.duration_sec : 60));
  const [eventType, setEventType] = useState(rule?.kind === 'event_type' ? rule.config.event_type : 'door_open');
  const [scopeTypes, setScopeTypes] = useState<string[]>(rule?.scope.device_types ?? []);
  const [scopeLocs, setScopeLocs] = useState<string[]>(rule?.scope.locations ?? []);
  const [cooldown, setCooldown] = useState(String(rule?.cooldown_sec ?? 120));
  const [autoResolve, setAutoResolve] = useState(rule?.auto_resolve ?? kind === 'absence');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const body = {
    name: name || 'Untitled rule',
    kind,
    severity,
    enabled: rule?.enabled ?? true,
    config: kind === 'threshold' ? { metric, operator: op, value: Number(value) } : kind === 'absence' ? { duration_sec: Number(duration) } : { event_type: eventType },
    scope: { ...(scopeTypes.length ? { device_types: scopeTypes } : {}), ...(scopeLocs.length ? { locations: scopeLocs } : {}) },
    cooldown_sec: Number(cooldown),
    auto_resolve: autoResolve,
  };
  const key = JSON.stringify(body);

  // Live dry-run against the last hour of real traffic, debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<Preview>('/api/rules/preview', body).then((p) => (setPreview(p), setPreviewErr(null))).catch((e) => (setPreview(null), setPreviewErr(e.message)));
    }, 350);
    return () => clearTimeout(t);
  }, [key]);

  const save = () =>
    run(async () => {
      if (rule) await api.put(`/api/rules/${rule.id}`, body);
      else await api.post('/api/rules', body);
      await refreshRules();
      onClose();
    }, rule ? 'Rule updated — effective within a second' : 'Rule created — effective within a second');

  const chips = (all: string[], sel: string[], set: (v: string[]) => void) => (
    <div className="chip-select">
      {all.map((x) => (
        <button key={x} className={sel.includes(x) ? 'on' : ''} onClick={() => set(sel.includes(x) ? sel.filter((y) => y !== x) : [...sel, x])}>{x.replace(/_/g, ' ')}</button>
      ))}
    </div>
  );

  return (
    <Drawer
      onClose={onClose}
      title={rule ? `Edit rule` : 'New detection rule'}
      sub={KIND_INFO[kind].help}
      actions={<button className="btn primary" onClick={save} disabled={busy}><Icon name="check" size={14} /> {rule ? 'Save changes' : 'Create rule'}</button>}
    >
      <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Freezer door left open" /></label>
      <label className="field">Type
        <Seg value={kind} onChange={(k) => (setKind(k), setAutoResolve(k === 'absence'))} options={(Object.keys(KIND_INFO) as Rule['kind'][]).map((k) => ({ value: k, label: KIND_INFO[k].label }))} />
      </label>

      {kind === 'threshold' && (
        <div className="grid" style={{ gridTemplateColumns: '1.4fr 0.8fr 1fr', gap: 10 }}>
          <label className="field">Metric
            <select className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>
              {['temperature', 'humidity', 'battery', 'rpm'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">Operator
            <select className="input" value={op} onChange={(e) => setOp(e.target.value)}>
              {['>', '>=', '<', '<=', '==', '!='].map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="field">Value<input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        </div>
      )}
      {kind === 'absence' && (
        <label className="field">Silent for (seconds)<input className="input" type="number" min={5} value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
      )}
      {kind === 'event_type' && (
        <label className="field">Event type
          <input className="input" list="event-types" value={eventType} onChange={(e) => setEventType(e.target.value)} />
          <datalist id="event-types">{['fault', 'tamper', 'door_open', 'boot', 'buffer_overflow'].map((t) => <option key={t} value={t} />)}</datalist>
        </label>
      )}

      <label className="field">Severity
        <Seg value={severity} onChange={setSeverity} options={(['low', 'medium', 'high', 'critical'] as Severity[]).map((s) => ({ value: s, label: s }))} />
      </label>
      <div className="field"><span>Device types <span className="muted">(none selected = all)</span></span>{chips(types, scopeTypes, setScopeTypes)}</div>
      <div className="field"><span>Locations <span className="muted">(none selected = all)</span></span>{chips(locations, scopeLocs, setScopeLocs)}</div>
      <div className="grid g-1-1" style={{ gap: 12 }}>
        <label className="field">Re-open cooldown (s)
          <input className="input" type="number" min={0} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
          <span className="muted small">A match this soon after resolving re-opens the old incident instead of creating a new one (anti-flapping).</span>
        </label>
        <label className="field">Auto-resolve
          <div className="flex"><Toggle on={autoResolve} onChange={setAutoResolve} /> <span className="small text-2">{kind === 'absence' ? 'when the device reports again' : kind === 'threshold' ? 'when a newer reading is back in range' : 'not applicable to events'}</span></div>
        </label>
      </div>

      <div className="callout accent">
        <div className="flex">
          <Icon name="rewind" size={14} color="var(--accent-2)" />
          <b>Dry run against the last hour of real traffic</b>
        </div>
        {previewErr && <div className="small" style={{ color: '#ff7b86', marginTop: 6 }}>{previewErr}</div>}
        {preview && (
          <div className="small text-2" style={{ marginTop: 6 }}>
            {kind === 'absence' ? (
              <>Right now <b>{preview.matched}</b> of {preview.evaluated} devices have been silent longer than {duration}s.</>
            ) : (
              <>
                Evaluated <b>{fmt(preview.evaluated)}</b> relevant events: <b>{fmt(preview.matched)}</b> would have matched
                {preview.matched > 0 && <> on <b>{preview.devices.length}</b> device(s) → about <b>{preview.estimated_incidents}</b> incident(s) after de-duplication</>}.
              </>
            )}
            {preview.devices.length > 0 && (
              <div className="flex wrap" style={{ marginTop: 8, gap: 6 }}>
                {preview.devices.slice(0, 10).map((d) => <Badge key={d.id} tone="accent">{d.name ?? d.id}{kind !== 'absence' && ` ×${d.matches}`}</Badge>)}
              </div>
            )}
            {preview.samples.length > 0 && (
              <div className="mono" style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
                {preview.samples.slice(0, 3).map((s, i) => <div key={i}>{s.device_id}: {s.reason}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
