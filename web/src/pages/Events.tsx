import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { go, useRoute } from '../router';
import { api } from '../api';
import { Ago, Badge, Drawer, EventStatus, Icon, Json, Panel, SevBadge, StatusBadge, clock, dateTime, dur } from '../components/ui';
import type { FleetEvent } from '../types';

type Flag = 'all' | 'late' | 'out_of_order' | 'incident' | 'failed';

export default function Events() {
  const route = useRoute();
  const live = useStore((s) => s.events);
  const devices = useStore((s) => s.devices);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<FleetEvent[] | null>(null);
  const [device, setDevice] = useState('');
  const [type, setType] = useState('');
  const [flag, setFlag] = useState<Flag>('all');
  const seen = useRef(new Set<number>());

  // Pausing freezes the visible list but keeps status updates flowing for rows already shown.
  const source = paused && frozen ? frozen.map((f) => live.find((e) => e.id === f.id) ?? f) : live;
  const types = useMemo(() => Array.from(new Set(live.map((e) => e.type))).sort(), [live]);
  const list = useMemo(
    () =>
      source.filter(
        (e) =>
          (!device || e.device_id === device) &&
          (!type || e.type === type) &&
          (flag === 'all' ||
            (flag === 'late' && e.late) ||
            (flag === 'out_of_order' && e.out_of_order) ||
            (flag === 'failed' && (e.status === 'failed' || (e.attempts ?? 0) > 1)) ||
            (flag === 'incident' && e.outcomes?.some((o) => o.incident_id))),
      ),
    [source, device, type, flag],
  );

  const isNew = (id: number) => {
    if (seen.current.has(id)) return false;
    seen.current.add(id);
    return seen.current.size > 50; // don't flash the whole initial page
  };

  return (
    <>
      <div className="flex wrap" style={{ gap: 10 }}>
        <button className={`btn ${paused ? 'primary' : ''}`} onClick={() => (setPaused(!paused), setFrozen(paused ? null : live))}>
          <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume live tail' : 'Pause'}
        </button>
        <select className="input" style={{ width: 210 }} value={device} onChange={(e) => setDevice(e.target.value)}>
          <option value="">All devices</option>
          {Object.values(devices).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.id})</option>)}
        </select>
        <select className="input" style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <div className="seg">
          {([['all', 'Everything'], ['incident', 'Raised incident'], ['late', 'Late / replayed'], ['out_of_order', 'Out of order'], ['failed', 'Retried / failed']] as [Flag, string][]).map(([v, l]) => (
            <button key={v} className={flag === v ? 'on' : ''} onClick={() => setFlag(v)}>{l}</button>
          ))}
        </div>
        <span className="muted small right">{paused ? 'Paused — new events are still being received' : `Streaming · showing ${list.length} of last ${live.length}`}</span>
      </div>
      {!paused && <div className="pulse-bar" />}
      <Panel flush>
        <div className="scroll" style={{ maxHeight: 'calc(100vh - 230px)' }}>
          <table className="t">
            <thead>
              <tr><th>Received</th><th>Device</th><th>Type</th><th>Payload</th><th>Occurred</th><th>Delivery</th><th>Processing</th><th>Result</th></tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={`click ${isNew(e.id) ? 'row-flash' : ''}`} onClick={() => go(`events/${e.id}`)}>
                  <td className="mono nowrap">{clock(e.received_at)}</td>
                  <td className="nowrap">{devices[e.device_id]?.name ?? e.device_id}</td>
                  <td><code>{e.type}</code></td>
                  <td className="mono ellipsis" style={{ maxWidth: 280 }}>{JSON.stringify(e.payload)}</td>
                  <td className="mono nowrap muted">{clock(e.ts)}</td>
                  <td className="nowrap">
                    {e.late && <Badge tone="warn" title="Arrived long after it happened (offline replay)">+{dur(e.received_at - e.ts)}</Badge>}
                    {e.out_of_order && <> <Badge tone="info" title="Older than an event already received from this device">reordered</Badge></>}
                    {!e.late && !e.out_of_order && <span className="muted small">on time</span>}
                  </td>
                  <td><EventStatus s={e.status} />{(e.attempts ?? 0) > 1 && <span className="muted small"> ×{e.attempts}</span>}</td>
                  <td className="nowrap small">
                    {e.outcomes?.filter((o) => o.incident_id).map((o) => (
                      <Badge key={o.rule_id} tone={o.outcome === 'created' ? 'danger' : 'accent'}>
                        {o.outcome === 'created' ? 'opened' : o.outcome === 'linked' ? 'linked' : o.outcome} #{o.incident_id}
                      </Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <div className="empty">No events match these filters yet.</div>}
        </div>
      </Panel>
      {route[1] && <EventDrawer id={Number(route[1])} />}
    </>
  );
}

interface EventDetail extends FleetEvent {
  lease_owner: string | null;
  processed_at: number | null;
  evaluations: { id: number; rule_id: number; rule_name: string; outcome: string; reason: string; incident_id: number | null; at: number }[];
  skipped: { rule_id: number; rule_name: string; reason: string }[];
  incidents: { id: number; title: string; status: 'open' | 'acknowledged' | 'resolved'; severity: 'low' | 'medium' | 'high' | 'critical' }[];
}

const OUTCOME: Record<string, { tone: string; label: string }> = {
  matched: { tone: 'danger', label: 'matched → opened' },
  linked: { tone: 'accent', label: 'matched → de-duplicated' },
  reopened: { tone: 'warn', label: 'matched → re-opened' },
  not_matched: { tone: 'muted', label: 'no match' },
  cleared: { tone: 'ok', label: 'cleared condition' },
  out_of_scope: { tone: 'outline', label: 'out of scope' },
};

function EventDrawer({ id }: { id: number }) {
  const liveStatus = useStore((s) => s.events.find((e) => e.id === id)?.status);
  const [d, setD] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<EventDetail>(`/api/events/${id}`).then(setD).catch((e) => setErr(e.message));
  }, [id, liveStatus]);

  return (
    <Drawer onClose={() => go('events')} title={d ? <span className="flex"><code style={{ fontSize: 15 }}>{d.type}</code> from {d.device_id}</span> : 'Event'} sub={d && <span className="mono">event_id {d.event_id} · #{d.id}</span>}>
      {err && <div className="empty">{err}</div>}
      {d && (
        <>
          <dl className="kv">
            <dt>Status</dt><dd><EventStatus s={d.status} /> {(d.attempts ?? 0) > 1 && <span className="muted small">after {d.attempts} attempts</span>}</dd>
            {d.last_error && <><dt>Last error</dt><dd className="mono small" style={{ color: '#ff7b86' }}>{d.last_error}</dd></>}
            <dt>Occurred (device)</dt><dd>{dateTime(d.ts)}</dd>
            <dt>Received (server)</dt><dd>{dateTime(d.received_at)} {d.late && <Badge tone="warn">{dur(d.received_at - d.ts)} late — replayed after reconnect</Badge>}</dd>
            <dt>Processed</dt><dd>{dateTime(d.processed_at)} {d.processed_at && <span className="muted small">({dur(d.processed_at - d.received_at)} after receipt)</span>}</dd>
            <dt>Sequence</dt><dd className="mono">{d.seq ?? '—'} {d.out_of_order && <Badge tone="info">arrived out of order — applied in device-time order</Badge>}</dd>
          </dl>
          <div>
            <div className="section-title">Payload</div>
            <Json value={d.payload} />
          </div>
          <div>
            <div className="section-title">Decision trace — why an incident was (or wasn't) created</div>
            {d.status !== 'processed' && <div className="callout warn small" style={{ marginBottom: 8 }}>This event has not been processed yet ({d.status}). Rules run once the worker picks it up.</div>}
            <div className="col">
              {d.evaluations.map((e) => {
                const o = OUTCOME[e.outcome] ?? { tone: 'muted', label: e.outcome };
                return (
                  <div key={e.id} className="callout small" style={{ padding: '9px 12px' }}>
                    <div className="flex">
                      <b>{e.rule_name}</b>
                      <span className="right"><Badge tone={o.tone}>{o.label}</Badge></span>
                    </div>
                    <div className="text-2 mono" style={{ marginTop: 4, fontSize: 12 }}>{e.reason}</div>
                    {e.incident_id && <a style={{ cursor: 'pointer', fontSize: 12 }} onClick={() => go(`incidents/${e.incident_id}`)}>Open INC-{e.incident_id} →</a>}
                  </div>
                );
              })}
              {d.skipped.map((s) => (
                <div key={s.rule_id} className="flex small" style={{ padding: '3px 12px', color: 'var(--muted)' }}>
                  <Icon name="x" size={12} /> <span className="text-2">{s.rule_name}</span> — not applicable: {s.reason}
                </div>
              ))}
            </div>
          </div>
          {d.incidents.length > 0 && (
            <div>
              <div className="section-title">Linked incidents</div>
              <div className="col">
                {d.incidents.map((i) => (
                  <div key={i.id} className="callout small flex" style={{ cursor: 'pointer' }} onClick={() => go(`incidents/${i.id}`)}>
                    <SevBadge s={i.severity} /> <span className="grow ellipsis">{i.title}</span> <StatusBadge s={i.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="muted small">Received <Ago ts={d.received_at} />. Duplicate deliveries of this <code>event_id</code> are acknowledged but never stored or evaluated twice.</div>
        </>
      )}
    </Drawer>
  );
}
