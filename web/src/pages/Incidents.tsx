import { useEffect, useMemo, useState } from 'react';
import { upsertIncident, useStore } from '../store';
import { go, useRoute } from '../router';
import { api } from '../api';
import { getOperator } from '../operator';
import { Ago, Badge, Icon, Panel, Seg, SevBadge, StatusBadge, dateTime, dur, sevColor, useAction, useNow } from '../components/ui';
import type { FleetEvent, Incident, Rule } from '../types';

type Filter = 'active' | 'open' | 'acknowledged' | 'resolved' | 'all';

export default function Incidents() {
  const route = useRoute();
  const selected = route[1] ? Number(route[1]) : null;
  const incidents = useStore((s) => s.incidents);
  const [filter, setFilter] = useState<Filter>('active');
  const [q, setQ] = useState('');

  const all = useMemo(() => Object.values(incidents), [incidents]);
  const counts = useMemo(() => ({
    active: all.filter((i) => i.status !== 'resolved').length,
    open: all.filter((i) => i.status === 'open').length,
    acknowledged: all.filter((i) => i.status === 'acknowledged').length,
    resolved: all.filter((i) => i.status === 'resolved').length,
    all: all.length,
  }), [all]);
  const list = useMemo(() => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return all
      .filter((i) => (filter === 'all' ? true : filter === 'active' ? i.status !== 'resolved' : i.status === filter))
      .filter((i) => !q || `${i.title} ${i.device_id} ${i.location}`.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) =>
        filter === 'resolved' || filter === 'all'
          ? b.last_triggered_at - a.last_triggered_at
          : (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || rank[a.severity] - rank[b.severity] || b.last_triggered_at - a.last_triggered_at,
      );
  }, [all, filter, q]);

  // Default to the first incident so the detail pane is never empty.
  useEffect(() => {
    if (!selected && list[0]) go(`incidents/${list[0].id}`);
  }, [selected, list]);

  return (
    <>
      <div className="flex wrap" style={{ gap: 12 }}>
        <Seg<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Active', n: counts.active },
            { value: 'open', label: 'Open', n: counts.open },
            { value: 'acknowledged', label: 'Acknowledged', n: counts.acknowledged },
            { value: 'resolved', label: 'Resolved', n: counts.resolved },
            { value: 'all', label: 'All', n: counts.all },
          ]}
        />
        <div className="flex right" style={{ position: 'relative' }}>
          <Icon name="search" size={14} color="var(--muted)" style={{ position: 'absolute', left: 10 }} />
          <input className="input" style={{ paddingLeft: 30, width: 260 }} placeholder="Filter by device, location…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(320px, 400px) minmax(0, 1fr)', alignItems: 'start' }}>
        <section className="panel scroll" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          {list.length === 0 && <div className="empty">No incidents in this view.</div>}
          {list.map((i) => (
            <div key={i.id} className={`inc-item ${selected === i.id ? 'sel' : ''}`} onClick={() => go(`incidents/${i.id}`)}>
              <div className="sev-bar" style={{ background: sevColor(i.severity) }} />
              <div className="grow">
                <div className="flex">
                  <span className="inc-title ellipsis grow">{i.rule_name}</span>
                  <span className="muted small mono">#{i.id}</span>
                </div>
                <div className="inc-meta">
                  <span>{i.device_name}</span>·<span>{i.location}</span>
                </div>
                <div className="inc-meta">
                  <StatusBadge s={i.status} />
                  <SevBadge s={i.severity} />
                  {i.trigger_count > 1 && <Badge tone="outline" title="Repeated matches folded into this incident">×{i.trigger_count}</Badge>}
                  {!!i.detected_late && <Badge tone="warn" title="Detected from events replayed after a disconnect">late</Badge>}
                  <span className="right"><Ago ts={i.last_triggered_at} /></span>
                </div>
              </div>
            </div>
          ))}
        </section>
        {selected ? <IncidentDetail id={selected} /> : <Panel><div className="empty">Select an incident</div></Panel>}
      </div>
    </>
  );
}

interface Detail extends Incident {
  rule: Rule;
  events: FleetEvent[];
  timeline: { id: number; at: number; kind: string; actor: string; detail: string }[];
  notifications: { id: number; operator_id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: number; sent_at: number | null; payload: any }[];
}

function IncidentDetail({ id }: { id: number }) {
  const live = useStore((s) => s.incidents[id]);
  const conn = useStore((s) => s.conn);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, run] = useAction();
  const now = useNow();

  // Re-fetch detail whenever the live incident row changes (new events, notifications, transitions).
  useEffect(() => {
    let cancelled = false;
    api.get<Detail>(`/api/incidents/${id}`).then((x) => !cancelled && (setD(x), setErr(null))).catch((e) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, live?.version, live?.trigger_count, live?.event_count, conn]);

  useEffect(() => setNote(''), [id]);

  if (err && !d) return <Panel><div className="empty">{err}</div></Panel>;
  if (!d) return <Panel><div className="empty">Loading…</div></Panel>;
  const inc = { ...d, ...(live ?? {}) };
  const offline = conn !== 'live';

  const act = (path: string, body: object, ok: string) =>
    run(async () => {
      const updated = await api.post<Incident>(`/api/incidents/${id}/${path}`, { actor: getOperator(), version: inc.version, ...body });
      upsertIncident(updated);
    }, ok);

  return (
    <section className="panel" style={{ minWidth: 0 }}>
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
        <div className="flex wrap" style={{ gap: 8, marginBottom: 8 }}>
          <SevBadge s={inc.severity} />
          <StatusBadge s={inc.status} />
          {inc.status !== 'resolved' && (
            <Badge tone={inc.condition_active ? 'danger' : 'ok'} dot>{inc.condition_active ? 'condition active' : 'condition cleared'}</Badge>
          )}
          {!!inc.detected_late && <Badge tone="warn">detected late (replayed data)</Badge>}
          <span className="muted small mono right">INC-{inc.id}</span>
        </div>
        <div style={{ fontSize: 19, fontWeight: 650, letterSpacing: '-0.015em' }}>{inc.title}</div>
        <div className="muted small" style={{ marginTop: 4 }}>
          Opened {dateTime(inc.opened_at)} · {inc.status === 'resolved' ? `resolved after ${dur((inc.resolved_at ?? now) - inc.opened_at)}` : `open for ${dur(now - inc.opened_at)}`}
          {inc.assignee && <> · routed to <b className="text-2">{inc.assignee}</b></>}
        </div>

        <div className="flex wrap" style={{ marginTop: 14, gap: 8 }}>
          {inc.status === 'open' && (
            <button className="btn primary" disabled={busy || offline} onClick={() => act('acknowledge', {}, `Acknowledged INC-${id}`)}>
              <Icon name="shield" size={14} /> Acknowledge
            </button>
          )}
          {inc.status !== 'resolved' && (
            <>
              <input className="input" style={{ maxWidth: 320 }} placeholder="Resolution note (optional)" value={note} onChange={(e) => setNote(e.target.value)} disabled={offline} />
              <button className="btn ok" disabled={busy || offline} onClick={() => act('resolve', { note }, `Resolved INC-${id}`)}>
                <Icon name="check" size={14} /> Resolve
              </button>
            </>
          )}
          {inc.status === 'resolved' && (
            <div className="callout small grow">
              <b>Resolved</b> by {inc.resolved_by} <Ago ts={inc.resolved_at} />{inc.resolution_note ? <> — “{inc.resolution_note}”</> : null}
            </div>
          )}
          <button className="btn ghost sm right" onClick={() => go(`devices/${inc.device_id}`)}>Open device →</button>
        </div>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="callout accent">
          <div className="section-title" style={{ color: 'var(--accent-2)' }}>Why this incident exists</div>
          <div>{inc.summary}</div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Rule <b className="text-2">{d.rule?.name}</b> ({describe(d.rule)}) · {inc.trigger_count} matching occurrence{inc.trigger_count === 1 ? '' : 's'} folded into this incident
            (de-duplicated per rule + device, {d.rule?.cooldown_sec}s re-open cooldown).
          </div>
        </div>

        <div className="grid g-1-1" style={{ gap: 20 }}>
          <div>
            <div className="section-title">Timeline</div>
            <div className="timeline">
              {d.timeline.map((t) => (
                <div key={t.id} className={`tl-item k-${t.kind}`}>
                  <div className="flex" style={{ gap: 6 }}>
                    <b style={{ fontSize: 12.5 }}>{t.kind.replace(/_/g, ' ')}</b>
                    <span className="muted small">{t.actor}</span>
                    <span className="muted small right">{dateTime(t.at)}</span>
                  </div>
                  <div className="text-2 small">{t.detail}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="section-title">Notifications</div>
            {d.notifications.length === 0 && <div className="muted small">No operator notifications for this incident.</div>}
            <div className="col">
              {d.notifications.map((n) => (
                <div key={n.id} className="callout small" style={{ padding: '9px 12px' }}>
                  <div className="flex">
                    <Icon name="mail" size={13} color="var(--muted)" />
                    <b>{n.payload?.to?.name ?? n.operator_id}</b>
                    <span className="muted">{n.kind}</span>
                    <span className="right">
                      <Badge tone={n.status === 'sent' ? 'ok' : n.status === 'dead' ? 'danger' : 'warn'} dot>
                        {n.status === 'pending' ? `retrying (${n.attempts})` : n.status}
                      </Badge>
                    </span>
                  </div>
                  {n.last_error && n.status !== 'sent' && <div className="muted" style={{ marginTop: 4 }}>last error: {n.last_error}</div>}
                  {n.sent_at && <div className="muted" style={{ marginTop: 4 }}>delivered {dateTime(n.sent_at)}{n.attempts > 1 ? ` after ${n.attempts} attempts` : ''}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="section-title">Evidence · {d.events.length} linked event{d.events.length === 1 ? '' : 's'}</div>
          {d.events.length === 0 ? (
            <div className="muted small">No events — this incident was raised by the absence of data (time-based rule).</div>
          ) : (
            <div className="scroll" style={{ maxHeight: 300, border: '1px solid var(--border)', borderRadius: 10 }}>
              <table className="t">
                <thead>
                  <tr><th>Occurred</th><th>Type</th><th>Payload</th><th>Delivery</th></tr>
                </thead>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.id} className="click" onClick={() => go(`events/${e.id}`)}>
                      <td className="nowrap mono">{dateTime(e.ts)}</td>
                      <td><code>{e.type}</code></td>
                      <td className="mono ellipsis" style={{ maxWidth: 260 }}>{JSON.stringify(e.payload)}</td>
                      <td className="nowrap">
                        {e.late ? <Badge tone="warn">+{dur(e.received_at - e.ts)} late</Badge> : <span className="muted small">on time</span>}
                        {e.out_of_order && <> <Badge tone="info">out of order</Badge></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function describe(r?: Rule) {
  if (!r) return '';
  if (r.kind === 'threshold') return `${r.config.metric} ${r.config.operator} ${r.config.value}`;
  if (r.kind === 'absence') return `no data for ${r.config.duration_sec}s`;
  return `event type = ${r.config.event_type}`;
}
