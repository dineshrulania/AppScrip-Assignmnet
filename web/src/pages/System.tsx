import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { go } from '../router';
import { api } from '../api';
import { Ago, Badge, Icon, Panel, Seg, Toggle, clock, dur, fmt, useAction } from '../components/ui';

interface Component {
  component: string;
  pid: number;
  started_at: number;
  beat_at: number;
  age_ms: number;
  healthy: boolean;
  info: Record<string, any>;
}

export interface SystemInfo {
  components: Component[];
  chaos: { processingFailureRate: number; workerPaused: boolean; processingDelayMs: number };
  dead_letters: { id: number; device_id: string; event_id: string; type: string; attempts: number; last_error: string; received_at: number }[];
  rejected: { id: number; received_at: number; device_id: string; reason: string; raw: string }[];
  undelivered_notifications: { id: number; incident_id: number; operator_id: string; attempts: number; last_error: string | null; created_at: number }[];
  stream_clients: number;
  change_cursor: number;
}

export function useSystem(intervalMs = 2000) {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<SystemInfo>('/api/system').then((s) => alive && setSys(s)).catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs, n]);
  return [sys, () => setN((x) => x + 1)] as const;
}

export function useNotifierMode() {
  const [mode, setMode] = useState<string | null>(null);
  const [inbox, setInbox] = useState<{ at: string; payload: any }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.get<{ mode: string; inbox: { at: string; payload: any }[] }>('/api/notifier/inbox')
        .then((r) => alive && (setMode(r.mode), setInbox(r.inbox)))
        .catch(() => alive && setMode('unreachable'));
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { mode, setMode, inbox };
}

const COMPONENTS: Record<string, { label: string; icon: string; desc: string }> = {
  api: { label: 'Ingestion & API', icon: 'server', desc: 'Accepts device events, serves operators, streams live updates' },
  worker: { label: 'Event processor', icon: 'cpu', desc: 'Claims events with a lease, evaluates rules, writes incidents' },
  scanner: { label: 'Silence scanner', icon: 'clock', desc: 'Detects offline devices and "stopped reporting" rules' },
  notifier: { label: 'Notification dispatcher', icon: 'bell', desc: 'Delivers the outbox with retries and a circuit breaker' },
};

export default function System() {
  const stats = useStore((s) => s.stats);
  const [sys, reload] = useSystem();
  const { mode, setMode, inbox } = useNotifierMode();
  const [busy, run] = useAction();

  const chaos = (patch: object, msg: string) => run(async () => { await api.post('/api/system/chaos', patch); reload(); }, msg);
  const notifier = (m: string) => run(async () => { await api.post('/api/notifier/mode', { mode: m }); setMode(m); }, `Notification service: ${m}`);

  return (
    <>
      <div className="grid g-4">
        {['api', 'worker', 'scanner', 'notifier'].map((key) => {
          const c = sys?.components.find((x) => x.component === key);
          const meta = COMPONENTS[key];
          const breaker = key === 'notifier' ? c?.info.breaker : null;
          const tone = !c ? 'muted' : !c.healthy ? 'danger' : breaker && breaker !== 'closed' ? 'warn' : 'ok';
          return (
            <section key={key} className="panel">
              <div className="health">
                <div className="health-icon" style={{ background: `var(--${tone === 'muted' ? 'panel-2' : tone + '-soft'})` }}>
                  <Icon name={meta.icon} size={17} color={`var(--${tone === 'muted' ? 'muted' : tone})`} />
                </div>
                <div className="grow">
                  <div className="flex"><b>{meta.label}</b></div>
                  <div className="small muted">{c ? <>pid {c.pid} · heartbeat <Ago ts={c.beat_at} /></> : 'no heartbeat yet'}</div>
                </div>
                <Badge tone={tone} dot>{!c ? 'unknown' : !c.healthy ? 'down' : breaker === 'open' ? 'breaker open' : breaker === 'half_open' ? 'probing' : 'healthy'}</Badge>
              </div>
              <div className="small text-2" style={{ padding: '0 16px 14px' }}>
                {meta.desc}
                {key === 'worker' && c && <div className="muted" style={{ marginTop: 4 }}>{fmt(c.info.processed)} processed · {fmt(c.info.failed)} failures since start · up {dur(Date.now() - c.started_at)}</div>}
                {key === 'notifier' && c && <div className="muted" style={{ marginTop: 4 }}>{fmt(c.info.sent)} sent · {fmt(c.info.failed)} failed attempts{c.info.last_error && breaker !== 'closed' ? ` · ${c.info.last_error}` : ''}</div>}
                {key === 'api' && sys && <div className="muted" style={{ marginTop: 4 }}>{sys.stream_clients} live dashboard(s) · change feed #{fmt(sys.change_cursor)}</div>}
                {key === 'scanner' && c?.info.last_run_at && <div className="muted" style={{ marginTop: 4 }}>last scan <Ago ts={c.info.last_run_at} /></div>}
              </div>
            </section>
          );
        })}
      </div>

      <div className="grid g-2-1">
        <Panel title="Pipeline" hint="device → ingest → durable queue → worker → incidents → outbox → notifier">
          <div className="grid g-4" style={{ gap: 12 }}>
            <Stat label="Queue depth" value={fmt(stats?.queue.depth)} sub={`watermark ${fmt(stats?.queue.high_watermark)} → 429`} tone={stats && stats.queue.depth > stats.queue.high_watermark * 0.5 ? 'warn' : undefined} />
            <Stat label="Oldest unprocessed" value={dur(stats?.queue.oldest_age_ms ?? 0)} sub="end-to-end freshness" />
            <Stat label="Lag p50 / p95" value={`${dur(stats?.processing_lag_ms.p50)} / ${dur(stats?.processing_lag_ms.p95)}`} sub={`${fmt(stats?.processing_lag_ms.samples)} events in 1m`} />
            <Stat label="Dead-letter" value={fmt(stats?.queue.dead_letter)} sub="exhausted retries" tone={stats?.queue.dead_letter ? 'danger' : undefined} />
            <Stat label="Accepted (24h)" value={fmt(stats?.events_total.accepted)} />
            <Stat label="Duplicates dropped" value={fmt(stats?.events_total.duplicates)} sub="idempotent ingest" />
            <Stat label="Late / replayed" value={fmt(stats?.events_total.late)} sub="delivered > 30s after event" />
            <Stat label="Rejected" value={fmt(stats?.events_total.rejected)} sub="malformed / skewed" tone={stats?.events_total.rejected ? 'warn' : undefined} />
          </div>
          <div className="flex small muted" style={{ marginTop: 14, gap: 14 }}>
            <a href="/readyz" target="_blank">/readyz</a><a href="/healthz" target="_blank">/healthz</a><a href="/metrics" target="_blank">/metrics (Prometheus)</a>
          </div>
        </Panel>

        <Panel title="Fault injection" hint="break things on purpose">
          <div className="col" style={{ gap: 14 }}>
            <div>
              <div className="flex small" style={{ marginBottom: 6 }}><b>Notification service</b><span className="right"><Badge tone={mode === 'up' ? 'ok' : mode === 'unreachable' ? 'danger' : 'warn'} dot>{mode ?? '…'}</Badge></span></div>
              <Seg value={mode ?? 'up'} onChange={notifier} options={[{ value: 'up', label: 'Up' }, { value: 'flaky', label: 'Flaky 50%' }, { value: 'slow', label: 'Slow 5s' }, { value: 'down', label: 'Down' }]} />
            </div>
            <div className="flex small">
              <div className="grow"><b>Pause event processor</b><div className="muted">Ingestion keeps accepting; backlog builds up</div></div>
              <Toggle on={!!sys?.chaos.workerPaused} disabled={busy} onChange={(v) => chaos({ workerPaused: v }, v ? 'Worker paused' : 'Worker resumed — draining backlog')} />
            </div>
            <div className="small">
              <div className="flex"><b>Processing failure rate</b><span className="right mono">{Math.round((sys?.chaos.processingFailureRate ?? 0) * 100)}%</span></div>
              <div className="muted" style={{ marginBottom: 4 }}>Failed events roll back, retry with backoff, then dead-letter</div>
              <input type="range" min={0} max={100} step={5} value={Math.round((sys?.chaos.processingFailureRate ?? 0) * 100)} onChange={(e) => chaos({ processingFailureRate: Number(e.target.value) / 100 }, `Failure rate ${e.target.value}%`)} />
            </div>
            <div className="small">
              <div className="flex"><b>Slow consumer</b><span className="right mono">{sys?.chaos.processingDelayMs ?? 0} ms/event</span></div>
              <input type="range" min={0} max={200} step={10} value={sys?.chaos.processingDelayMs ?? 0} onChange={(e) => chaos({ processingDelayMs: Number(e.target.value) }, `Processing delay ${e.target.value}ms/event`)} />
            </div>
            <button className="btn sm" disabled={busy} onClick={() => chaos({ processingFailureRate: 0, workerPaused: false, processingDelayMs: 0 }, 'All faults cleared').then(() => notifier('up'))}>
              <Icon name="refresh" size={13} /> Reset all faults
            </button>
          </div>
        </Panel>
      </div>

      <div className="grid g-1-1">
        <Panel title="Dead-letter queue" hint="events that failed every retry" flush>
          <DLQ rows={sys?.dead_letters ?? []} onRequeue={(id) => run(async () => { await api.post(`/api/events/${id}/requeue`); reload(); }, `Event #${id} re-queued`)} busy={busy} />
        </Panel>
        <Panel title="Operator inbox" hint="what the notification service actually delivered" flush>
          <div className="scroll" style={{ maxHeight: 300 }}>
            {inbox.length === 0 && <div className="empty">No notifications delivered yet.</div>}
            {inbox.slice(0, 40).map((m, i) => (
              <div key={i} className="feed-item" style={{ cursor: 'pointer' }} onClick={() => m.payload?.incident_id && go(`incidents/${m.payload.incident_id}`)}>
                <div className="feed-icon" style={{ background: 'var(--info-soft)' }}><Icon name="mail" size={13} color="#7dd3fc" /></div>
                <div className="grow">
                  <div className="ellipsis" style={{ fontWeight: 550 }}>{m.payload?.subject}</div>
                  <div className="muted small">to {m.payload?.to?.name} &lt;{m.payload?.to?.email}&gt;</div>
                </div>
                <span className="muted small mono">{clock(Date.parse(m.at))}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid g-1-1">
        <Panel title="Rejected payloads" hint="validation failures, kept for debugging" flush>
          <div className="scroll" style={{ maxHeight: 280 }}>
            <table className="t">
              <thead><tr><th>Time</th><th>Device</th><th>Reason</th></tr></thead>
              <tbody>
                {(sys?.rejected ?? []).map((r) => (
                  <tr key={r.id} title={r.raw}>
                    <td className="mono nowrap">{clock(r.received_at)}</td>
                    <td className="nowrap">{r.device_id}</td>
                    <td className="small" style={{ color: '#ffc15e' }}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!sys?.rejected.length && <div className="empty">Nothing rejected.</div>}
          </div>
        </Panel>
        <Panel title="Undelivered notifications" hint="pending retries or given up" flush>
          <div className="scroll" style={{ maxHeight: 280 }}>
            <table className="t">
              <thead><tr><th>Incident</th><th>Operator</th><th>Attempts</th><th>Last error</th></tr></thead>
              <tbody>
                {(sys?.undelivered_notifications ?? []).map((n) => (
                  <tr key={n.id} className="click" onClick={() => go(`incidents/${n.incident_id}`)}>
                    <td className="mono">INC-{n.incident_id}</td>
                    <td>{n.operator_id}</td>
                    <td className="mono">{n.attempts}</td>
                    <td className="small muted ellipsis" style={{ maxWidth: 220 }}>{n.last_error ?? 'waiting'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!sys?.undelivered_notifications.length && <div className="empty">Every notification has been delivered.</div>}
          </div>
        </Panel>
      </div>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 19, fontWeight: 650, marginTop: 2, color: tone === 'danger' ? '#ff7b86' : tone === 'warn' ? '#ffc15e' : undefined }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>}
    </div>
  );
}

function DLQ({ rows, onRequeue, busy }: { rows: SystemInfo['dead_letters']; onRequeue: (id: number) => void; busy: boolean }) {
  return (
    <div className="scroll" style={{ maxHeight: 300 }}>
      <table className="t">
        <thead><tr><th>Event</th><th>Device</th><th>Attempts</th><th>Error</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><a style={{ cursor: 'pointer' }} onClick={() => go(`events/${r.id}`)} className="mono">#{r.id} {r.type}</a></td>
              <td>{r.device_id}</td>
              <td className="mono">{r.attempts}</td>
              <td className="small ellipsis" style={{ maxWidth: 200, color: '#ff7b86' }}>{r.last_error}</td>
              <td><button className="btn sm" disabled={busy} onClick={() => onRequeue(r.id)}><Icon name="refresh" size={12} /> Re-queue</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">Empty — every accepted event was processed.</div>}
    </div>
  );
}
