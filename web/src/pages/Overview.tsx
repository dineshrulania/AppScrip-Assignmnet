import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { go } from '../router';
import { api } from '../api';
import { Ago, Badge, Icon, Panel, SevBadge, StatusBadge, dur, fmt, sevColor } from '../components/ui';
import { Legend, Sparkline, StackedBars } from '../components/charts';
import type { Device, Incident, Severity } from '../types';

export const SERIES = [
  { key: 'accepted' as const, label: 'Accepted', color: 'var(--c-accepted)' },
  { key: 'late' as const, label: 'Late / replayed', color: 'var(--c-late)' },
  { key: 'duplicates' as const, label: 'Duplicates dropped', color: 'var(--c-duplicates)' },
  { key: 'rejected' as const, label: 'Rejected', color: 'var(--c-rejected)' },
];

/** "accepted" includes late events; split them so the stack adds up. */
export const chartData = (points: { t: number; accepted: number; late: number; duplicates: number; rejected: number }[]) =>
  points.map((p) => ({ ...p, accepted: Math.max(0, p.accepted - p.late) }));

export function useActiveByDevice() {
  const incidents = useStore((s) => s.incidents);
  return useMemo(() => {
    const m = new Map<string, Incident[]>();
    for (const i of Object.values(incidents)) if (i.status !== 'resolved') m.set(i.device_id, [...(m.get(i.device_id) ?? []), i]);
    return m;
  }, [incidents]);
}

export default function Overview() {
  return (
    <>
      <Kpis />
      <div className="grid g-2-1">
        <Throughput />
        <ActiveIncidents />
      </div>
      <div className="grid g-2-1">
        <FleetMap />
        <Activity />
      </div>
    </>
  );
}

function Kpis() {
  const s = useStore((st) => st.stats);
  const series = useStore((st) => st.series);
  const perBucket = series.map((p) => p.accepted);
  const rate = s ? s.events_last_min.accepted : 0;
  const sev = s?.incidents.active_by_severity ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const active = (s?.incidents.open ?? 0) + (s?.incidents.acknowledged ?? 0);
  const onlinePct = s && s.devices.total ? (s.devices.online / s.devices.total) * 100 : 0;
  const lagTone = !s ? 'muted' : s.processing_lag_ms.p95 > 5000 || s.queue.depth > 1000 ? 'danger' : s.processing_lag_ms.p95 > 1000 ? 'warn' : 'ok';

  return (
    <div className="grid g-kpi">
      <div className="panel kpi">
        <div className="kpi-label"><Icon name="cpu" size={14} /> Fleet online</div>
        <div className="kpi-value">{s?.devices.online ?? '–'}<small>/ {s?.devices.total ?? '–'}</small></div>
        <div className="meter" style={{ marginTop: 4 }}>
          <span style={{ width: `${onlinePct}%`, background: 'var(--ok)' }} />
          <span style={{ width: `${100 - onlinePct}%`, background: s?.devices.offline ? 'var(--danger)' : 'transparent' }} />
        </div>
        <div className="kpi-foot">{s?.devices.offline ? <Badge tone="danger" dot>{s.devices.offline} offline</Badge> : <Badge tone="ok" dot>all reporting</Badge>}</div>
      </div>

      <div className="panel kpi">
        <div className="kpi-label"><Icon name="activity" size={14} /> Events / min</div>
        <div className="kpi-value">{fmt(rate)}</div>
        <div className="kpi-foot">
          <span>{fmt(s?.events_last_min.duplicates)} dup</span>
          <span>{fmt(s?.events_last_min.late)} late</span>
          <span>{fmt(s?.events_last_min.rejected)} rejected</span>
        </div>
        <Sparkline values={perBucket.slice(-30)} />
      </div>

      <div className="panel kpi" style={{ cursor: 'pointer' }} onClick={() => go('incidents')}>
        <div className="kpi-label"><Icon name="alert" size={14} /> Active incidents</div>
        <div className="kpi-value" style={{ color: sev.critical ? '#ff7b86' : undefined }}>{active}</div>
        <div className="meter">
          {(['critical', 'high', 'medium', 'low'] as Severity[]).map((k) => (
            <span key={k} style={{ width: active ? `${(sev[k] / active) * 100}%` : 0, background: sevColor(k) }} />
          ))}
        </div>
        <div className="kpi-foot">
          {sev.critical > 0 && <span style={{ color: '#ff7b86' }}>{sev.critical} critical</span>}
          {sev.high > 0 && <span style={{ color: '#ffa36b' }}>{sev.high} high</span>}
          <span>{s?.incidents.open ?? 0} unacked</span>
        </div>
      </div>

      <div className="panel kpi">
        <div className="kpi-label"><Icon name="zap" size={14} /> Processing lag (p95)</div>
        <div className="kpi-value">{s ? dur(s.processing_lag_ms.p95) : '–'}</div>
        <div className="kpi-foot">
          <Badge tone={lagTone} dot>queue {fmt(s?.queue.depth)}</Badge>
          {s && s.queue.dead_letter > 0 && <Badge tone="danger">{s.queue.dead_letter} dead-letter</Badge>}
        </div>
      </div>

      <div className="panel kpi">
        <div className="kpi-label"><Icon name="bell" size={14} /> Notifications</div>
        <div className="kpi-value">{fmt(s?.notifications.sent)}<small>sent</small></div>
        <div className="kpi-foot">
          {s && s.notifications.pending > 0 ? <Badge tone="warn" dot>{s.notifications.pending} retrying</Badge> : <Badge tone="ok" dot>none pending</Badge>}
          {s && s.notifications.dead > 0 && <Badge tone="danger">{s.notifications.dead} failed</Badge>}
          {s?.incidents.mtta_ms != null && <span>MTTA {dur(s.incidents.mtta_ms)}</span>}
        </div>
      </div>
    </div>
  );
}

function Throughput() {
  const series = useStore((s) => s.series);
  const bursts = useStore((s) => s.bursts);
  const recentBurst = bursts[0] && Date.now() - bursts[0].at < 20_000 ? bursts[0] : null;
  return (
    <Panel
      title="Ingestion throughput"
      hint="events per 10s · last 15 min"
      right={<Legend items={SERIES.map((s) => ({ label: s.label, color: s.color }))} />}
    >
      {recentBurst && (
        <div className="callout warn small" style={{ marginBottom: 10 }}>
          <b>Burst detected:</b> {recentBurst.device_id} just delivered {recentBurst.accepted} events in one request
          {recentBurst.late ? ` (${recentBurst.late} replayed from its offline buffer)` : ''}.
        </div>
      )}
      <StackedBars data={chartData(series)} series={SERIES} height={210} format={(n) => fmt(n)} />
    </Panel>
  );
}

function ActiveIncidents() {
  const incidents = useStore((s) => s.incidents);
  const list = useMemo(
    () =>
      Object.values(incidents)
        .filter((i) => i.status !== 'resolved')
        .sort((a, b) => (a.status === b.status ? b.last_triggered_at - a.last_triggered_at : a.status === 'open' ? -1 : 1))
        .slice(0, 7),
    [incidents],
  );
  return (
    <Panel title="Needs attention" hint={`${list.length} active`} right={<button className="btn sm ghost" onClick={() => go('incidents')}>View all →</button>} flush>
      {list.length === 0 && <div className="empty"><Icon name="check" size={22} color="var(--ok)" /><div style={{ marginTop: 8 }}>All clear — no active incidents.</div></div>}
      {list.map((i) => (
        <div key={i.id} className="inc-item" onClick={() => go(`incidents/${i.id}`)}>
          <div className="sev-bar" style={{ background: sevColor(i.severity) }} />
          <div className="grow">
            <div className="inc-title ellipsis">{i.rule_name}</div>
            <div className="inc-meta">
              <span>{i.device_name}</span>·<span>{i.location}</span>·<Ago ts={i.opened_at} />
              {i.trigger_count > 1 && <Badge tone="outline">×{i.trigger_count}</Badge>}
            </div>
          </div>
          <div className="col" style={{ alignItems: 'flex-end', gap: 5 }}>
            <SevBadge s={i.severity} />
            <StatusBadge s={i.status} />
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function primaryReading(d: Device) {
  const t = d.latest?.temperature;
  if (d.type === 'access') return d.latest?.battery ? { v: d.latest.battery.v, unit: '%', label: 'battery' } : null;
  return t ? { v: t.v, unit: '°C', label: 'temp' } : null;
}

function FleetMap() {
  const devices = useStore((s) => s.devices);
  const active = useActiveByDevice();
  const byLoc = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of Object.values(devices)) m.set(d.location, [...(m.get(d.location) ?? []), d]);
    return [...m.entries()].sort();
  }, [devices]);

  return (
    <Panel title="Fleet by location" hint="click a device for details" right={<button className="btn sm ghost" onClick={() => go('devices')}>All devices →</button>}>
      {byLoc.length === 0 && <div className="empty">No devices registered yet. Start the simulator (<code>npm run dev</code>).</div>}
      <div className="grid g-1-1" style={{ gap: 12 }}>
        {byLoc.map(([loc, list]) => {
          const online = list.filter((d) => d.status === 'online').length;
          return (
            <div key={loc} className="loc">
              <div className="loc-head">
                <Icon name="map" size={14} color="var(--muted)" />
                {loc}
                <span className="muted small right">{online}/{list.length} online</span>
              </div>
              <div className="dev-tiles">
                {list.map((d) => {
                  const r = primaryReading(d);
                  const inc = active.get(d.id) ?? [];
                  return (
                    <div key={d.id} className={`dev-tile ${inc.length ? 'alert' : ''} ${d.status !== 'online' ? 'off' : ''}`} onClick={() => go(`devices/${d.id}`)}>
                      <div className="flex">
                        <span className={`status-dot ${d.status}`} />
                        <span className="name ellipsis">{d.name}</span>
                      </div>
                      <div className="flex">
                        <span className="reading">{r ? `${r.v.toFixed(1)}${r.unit}` : '—'}</span>
                        {inc.length > 0 && <span className="right"><SevBadge s={inc[0].severity} /></span>}
                      </div>
                      <div className="muted small ellipsis">{d.status === 'online' ? d.type.replace('_', ' ') : <>offline · <Ago ts={d.last_seen_at} /></>}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

interface ActivityItem {
  at: number;
  kind: string;
  detail: string;
  source: 'incident' | 'device';
  device_id: string;
  incident_id?: number;
  title?: string;
  actor?: string;
}

const ACT_STYLE: Record<string, { icon: string; color: string; bg: string }> = {
  opened: { icon: 'alert', color: '#ff7b86', bg: 'var(--danger-soft)' },
  reopened: { icon: 'refresh', color: '#ff7b86', bg: 'var(--danger-soft)' },
  acknowledged: { icon: 'shield', color: '#ffc15e', bg: 'var(--warn-soft)' },
  resolved: { icon: 'check', color: '#5ee08f', bg: 'var(--ok-soft)' },
  auto_resolved: { icon: 'check', color: '#5ee08f', bg: 'var(--ok-soft)' },
  condition_cleared: { icon: 'check', color: '#5ee08f', bg: 'var(--ok-soft)' },
  notified: { icon: 'mail', color: '#7dd3fc', bg: 'var(--info-soft)' },
  notify_retry: { icon: 'bell', color: '#ffc15e', bg: 'var(--warn-soft)' },
  notify_dead: { icon: 'bell', color: '#ff7b86', bg: 'var(--danger-soft)' },
  online: { icon: 'wifi', color: '#5ee08f', bg: 'var(--ok-soft)' },
  offline: { icon: 'wifiOff', color: '#ff7b86', bg: 'var(--danger-soft)' },
  reboot: { icon: 'power', color: '#a18bff', bg: 'var(--accent-soft)' },
};

function Activity() {
  const pulse = useStore((s) => s.pulse);
  const conn = useStore((s) => s.conn);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (conn !== 'live') return;
    api.get<ActivityItem[]>('/api/activity').then(setItems).catch(() => {});
  }, [tick, conn, Math.floor(pulse / 50)]);

  return (
    <Panel title="Recent activity" hint="incidents, notifications & connectivity" flush>
      <div className="feed scroll" style={{ maxHeight: 470 }}>
        {items.length === 0 && <div className="empty">Nothing yet.</div>}
        {items.slice(0, 40).map((a, idx) => {
          const st = ACT_STYLE[a.kind] ?? { icon: 'info', color: 'var(--text-2)', bg: 'var(--panel-2)' };
          return (
            <div key={idx} className="feed-item" style={{ cursor: 'pointer' }} onClick={() => go(a.incident_id ? `incidents/${a.incident_id}` : `devices/${a.device_id}`)}>
              <div className="feed-icon" style={{ background: st.bg }}><Icon name={st.icon} size={13} color={st.color} /></div>
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 550 }}>{a.title ?? a.device_id}</div>
                <div className="text-2" style={{ fontSize: 12 }}>{a.detail}</div>
              </div>
              <div className="muted small nowrap"><Ago ts={a.at} /></div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
