import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { go, useRoute } from '../router';
import { api } from '../api';
import { Ago, Badge, DeviceStatus, Drawer, Icon, Panel, Seg, SevBadge, StatusBadge, dateTime, fmt, useAction } from '../components/ui';
import { LineChart } from '../components/charts';
import { primaryReading, useActiveByDevice } from './Overview';
import type { Device, Rule } from '../types';

export interface SimDevice {
  id: string;
  mode: 'online' | 'offline' | 'powered_off';
  buffered: number;
  dropped: number;
  seq: number;
  boot_id: string;
  spiking: boolean;
  offline_for_s: number;
  sent: number;
  duplicates_sent: number;
  last_error: string | null;
}

/** Poll the simulator's view of devices (their local buffers) - only while something needs it. */
export function useSimDevices(enabled = true) {
  const [sim, setSim] = useState<Record<string, SimDevice> | null>(null);
  const [chaos, setChaos] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      api.get<{ chaos: boolean; devices: SimDevice[] }>('/api/sim/devices')
        .then((r) => alive && (setSim(Object.fromEntries(r.devices.map((d) => [d.id, d]))), setChaos(r.chaos)))
        .catch(() => alive && setSim(null));
    load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return { sim, chaos, setChaos };
}

type Filter = 'all' | 'online' | 'offline' | 'alerting';

export default function Devices() {
  const route = useRoute();
  const devices = useStore((s) => s.devices);
  const active = useActiveByDevice();
  const [filter, setFilter] = useState<Filter>('all');
  const { sim } = useSimDevices();

  const list = useMemo(
    () =>
      Object.values(devices)
        .filter((d) => (filter === 'all' ? true : filter === 'alerting' ? active.has(d.id) : filter === 'online' ? d.status === 'online' : d.status !== 'online'))
        .sort((a, b) => a.location.localeCompare(b.location) || a.id.localeCompare(b.id)),
    [devices, filter, active],
  );
  const all = Object.values(devices);

  return (
    <>
      <div className="flex">
        <Seg<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', n: all.length },
            { value: 'online', label: 'Online', n: all.filter((d) => d.status === 'online').length },
            { value: 'offline', label: 'Offline', n: all.filter((d) => d.status !== 'online').length },
            { value: 'alerting', label: 'With incidents', n: active.size },
          ]}
        />
      </div>
      <Panel flush>
        <div className="scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Device</th><th>Location</th><th>Status</th><th>Reading</th><th>Battery</th><th>Last seen</th>
                <th title="Events accepted / duplicates dropped / delivered late">Events · dup · late</th>
                <th title="Simulator-side store-and-forward buffer">Device buffer</th><th>Incidents</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => {
                const r = primaryReading(d);
                const inc = active.get(d.id) ?? [];
                const s = sim?.[d.id];
                return (
                  <tr key={d.id} className="click" onClick={() => go(`devices/${d.id}`)}>
                    <td>
                      <div className="b600">{d.name}</div>
                      <div className="muted small mono">{d.id} · {d.type}</div>
                    </td>
                    <td className="text-2">{d.location}</td>
                    <td><DeviceStatus s={d.status} /></td>
                    <td className="mono">{r ? `${r.v.toFixed(1)}${r.unit}` : '—'}</td>
                    <td className="mono">{d.latest?.battery ? `${d.latest.battery.v.toFixed(0)}%` : '—'}</td>
                    <td className="nowrap text-2"><Ago ts={d.last_seen_at} /></td>
                    <td className="mono small">{fmt(d.events_total)} · {fmt(d.duplicates_total)} · {fmt(d.late_total)}</td>
                    <td>
                      {!s ? <span className="muted small">—</span>
                        : s.mode === 'powered_off' ? <Badge tone="danger">powered off</Badge>
                        : s.buffered > 0 ? <Badge tone={s.mode === 'offline' ? 'warn' : 'info'}>{s.buffered} buffered</Badge>
                        : <span className="muted small">empty</span>}
                    </td>
                    <td>{inc.length ? <SevBadge s={inc[0].severity} /> : <span className="muted small">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length === 0 && <div className="empty">No devices match.</div>}
        </div>
      </Panel>
      {route[1] && <DeviceDrawer id={route[1]} sim={sim?.[route[1]] ?? null} />}
    </>
  );
}

interface DeviceDetail extends Device {
  readings: ({ ts: number } & Record<string, number>)[];
  incidents: { id: number; title: string; status: 'open' | 'acknowledged' | 'resolved'; severity: 'low' | 'medium' | 'high' | 'critical'; opened_at: number }[];
  log: { at: number; kind: string; detail: string }[];
}

function DeviceDrawer({ id, sim }: { id: string; sim: SimDevice | null }) {
  const live = useStore((s) => s.devices[id]);
  const rules = useStore((s) => s.rules);
  const conn = useStore((s) => s.conn);
  const [d, setD] = useState<DeviceDetail | null>(null);
  const [metric, setMetric] = useState('temperature');
  const [busy, run] = useAction();

  useEffect(() => {
    let alive = true;
    const load = () => api.get<DeviceDetail>(`/api/devices/${id}`).then((x) => alive && setD(x)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  const dev = { ...d, ...live } as DeviceDetail;
  const metrics = useMemo(() => Object.keys(dev?.latest ?? {}), [dev?.latest]);
  useEffect(() => {
    if (metrics.length && !metrics.includes(metric)) setMetric(metrics[0]);
  }, [metrics, metric]);

  const threshold = useMemo(() => {
    const r = rules.find((r: Rule) => r.enabled && r.kind === 'threshold' && r.config.metric === metric &&
      (!r.scope.device_types?.length || r.scope.device_types.includes(dev?.type)) &&
      (!r.scope.locations?.length || r.scope.locations.includes(dev?.location)));
    return r ? { value: r.config.value, op: r.config.operator } : null;
  }, [rules, metric, dev?.type, dev?.location]);

  const points = useMemo(() => (d?.readings ?? []).filter((r) => typeof r[metric] === 'number').map((r) => ({ t: r.ts, v: r[metric] })), [d?.readings, metric]);

  const sim$ = (action: string, body: object = {}, msg?: string) =>
    run(() => api.post(`/api/sim/devices/${id}/${action}`, body), msg);

  if (!live && !d) return null;

  return (
    <Drawer
      onClose={() => go('devices')}
      title={<span className="flex">{dev.name} <DeviceStatus s={dev.status} /></span>}
      sub={<span className="mono">{dev.id} · {dev.type} · {dev.location}</span>}
    >
      <dl className="kv">
        <dt>Last seen</dt><dd><Ago ts={dev.last_seen_at} /> <span className="muted small">({dateTime(dev.last_seen_at)})</span></dd>
        <dt>Status since</dt><dd>{dateTime(dev.status_since)}</dd>
        <dt>Newest event time</dt><dd>{dateTime(dev.last_event_ts)} <span className="muted small">(device clock)</span></dd>
        <dt>Boot / sequence</dt><dd className="mono">{dev.boot_id ?? '—'} / #{dev.last_seq ?? '—'}</dd>
        <dt>Traffic</dt><dd>{fmt(dev.events_total)} accepted · {fmt(dev.duplicates_total)} duplicates dropped · {fmt(dev.late_total)} delivered late</dd>
      </dl>

      {sim && (
        <div className={`callout ${sim.mode !== 'online' ? 'warn' : ''}`}>
          <div className="flex">
            <Icon name="cpu" size={14} />
            <b>Device-side view (simulator)</b>
            <span className="right"><Badge tone={sim.mode === 'online' ? 'ok' : 'warn'}>{sim.mode.replace('_', ' ')}</Badge></span>
          </div>
          <div className="small text-2" style={{ marginTop: 6 }}>
            {sim.mode === 'offline' && <>Network down for another {sim.offline_for_s}s — </>}
            <b>{sim.buffered}</b> event(s) in the local store-and-forward buffer
            {sim.mode === 'offline' ? ', will be replayed oldest-first on reconnect.' : '.'}
            {sim.dropped > 0 && <> {sim.dropped} dropped (buffer full).</>}
            {sim.last_error && <> Last upload error: <code>{sim.last_error}</code>.</>}
          </div>
        </div>
      )}

      <div>
        <div className="flex" style={{ marginBottom: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>Readings · last 30 min</div>
          <span className="right">
            <Seg value={metric} onChange={setMetric} options={metrics.map((m) => ({ value: m, label: m }))} />
          </span>
        </div>
        <div className="panel" style={{ padding: 10 }}>
          <LineChart points={points} threshold={threshold} unit={metric === 'temperature' ? '°C' : metric === 'battery' || metric === 'humidity' ? '%' : ''} />
        </div>
      </div>

      <div>
        <div className="section-title">Simulate on this device</div>
        <div className="flex wrap">
          <button className="btn sm" disabled={busy || !sim || conn !== 'live'} onClick={() => sim$('offline', { seconds: 45 }, 'Network cut for 45s — watch it buffer, then replay')}><Icon name="wifiOff" size={13} /> Cut network 45s</button>
          <button className="btn sm" disabled={busy || !sim || sim.mode === 'online'} onClick={() => sim$('online', {}, 'Reconnecting…')}><Icon name="wifi" size={13} /> Reconnect now</button>
          {sim?.mode === 'powered_off'
            ? <button className="btn sm" disabled={busy} onClick={() => sim$('power', { on: true }, 'Powered on')}><Icon name="power" size={13} /> Power on</button>
            : <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('power', { on: false }, 'Powered off — no buffering, expect a "stopped reporting" incident in ~30s')}><Icon name="power" size={13} /> Power off</button>}
          <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('spike', { seconds: 20 }, 'Temperature excursion for 20s')}><Icon name="thermo" size={13} /> Temperature spike</button>
          <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('fault', {}, 'Fault event emitted')}><Icon name="bug" size={13} /> Report fault</button>
          <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('duplicate', {}, 'Re-sent 20 already-delivered events')}><Icon name="copy" size={13} /> Re-send duplicates</button>
          <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('malformed', {}, 'Malformed payloads sent')}><Icon name="x" size={13} /> Malformed payload</button>
          <button className="btn sm" disabled={busy || !sim} onClick={() => sim$('reboot', {}, 'Rebooted — new boot id, sequence restarts')}><Icon name="refresh" size={13} /> Reboot</button>
        </div>
        {!sim && <div className="muted small" style={{ marginTop: 6 }}>Simulator not reachable — start it with <code>npm run dev</code>.</div>}
      </div>

      <div className="grid g-1-1" style={{ gap: 18 }}>
        <div>
          <div className="section-title">Incidents</div>
          {(d?.incidents ?? []).length === 0 && <div className="muted small">None.</div>}
          <div className="col">
            {(d?.incidents ?? []).map((i) => (
              <div key={i.id} className="callout small flex" style={{ padding: '8px 10px', cursor: 'pointer' }} onClick={() => go(`incidents/${i.id}`)}>
                <SevBadge s={i.severity} />
                <span className="ellipsis grow">{i.title.split(' — ')[0]}</span>
                <StatusBadge s={i.status} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="section-title">Connectivity log</div>
          {(d?.log ?? []).length === 0 && <div className="muted small">No transitions yet.</div>}
          <div className="timeline">
            {(d?.log ?? []).map((l, i) => (
              <div key={i} className={`tl-item k-${l.kind === 'online' ? 'resolved' : l.kind === 'offline' ? 'opened' : 'notified'}`}>
                <div className="flex"><b style={{ fontSize: 12.5 }}>{l.kind}</b><span className="muted small right">{dateTime(l.at)}</span></div>
                <div className="text-2 small">{l.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="muted small">Tip: actions above drive the simulator. Everything you see change here arrives through the same ingestion API real devices use.{' '}
        <a onClick={() => go('lab')} style={{ cursor: 'pointer' }}>More scenarios in the Failure lab →</a>
      </div>
    </Drawer>
  );
}
