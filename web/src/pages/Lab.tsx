import { useStore } from '../store';
import { go } from '../router';
import { api } from '../api';
import { Badge, Icon, Toggle, toast, useAction } from '../components/ui';
import { useSimDevices } from './Devices';
import { useNotifierMode } from './System';

interface Scenario {
  title: string;
  icon: string;
  story: string;
  run: { label: string; fn: () => Promise<unknown>; ok: string };
  undo?: { label: string; fn: () => Promise<unknown>; ok: string };
  watch: { text: string; link?: string }[];
  guarantee: string;
}

const sim = (path: string, body: object = {}) => api.post(`/api/sim/${path}`, body);
const chaos = (body: object) => api.post('/api/system/chaos', body);
const notifier = (mode: string) => api.post('/api/notifier/mode', { mode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS: Scenario[] = [
  {
    title: 'Network loss, offline buffering & replay',
    icon: 'wifiOff',
    story: 'Cold Store Unit A loses connectivity for 45 seconds. It keeps measuring and buffers locally, then reconnects and replays everything it missed.',
    run: { label: 'Cut network for 45s', fn: () => sim('devices/cs-nw-01/offline', { seconds: 45 }), ok: 'cs-nw-01 is offline and buffering' },
    undo: { label: 'Reconnect now', fn: () => sim('devices/cs-nw-01/online'), ok: 'Reconnecting — watch the replay' },
    watch: [
      { text: 'After ~20s the device turns offline on the fleet map', link: '' },
      { text: 'After 30s a "Device stopped reporting" incident opens', link: 'incidents' },
      { text: 'Device drawer shows the growing local buffer', link: 'devices/cs-nw-01' },
      { text: 'On reconnect: a burst of late events, then the incident auto-resolves', link: 'events' },
    ],
    guarantee: 'Silence is measured on the server clock from the last authenticated contact. Replayed events are stored with their original timestamp and flagged late; they never overwrite newer readings.',
  },
  {
    title: 'Temperature excursion → one incident, not fifty',
    icon: 'thermo',
    story: 'Reefer Bay 1 warms past the 8 °C cold-chain limit for 20 seconds, producing ten or more breaching readings.',
    run: { label: 'Trigger excursion', fn: () => sim('devices/cs-ep-01/spike', { seconds: 20 }), ok: 'Temperature rising on cs-ep-01' },
    watch: [
      { text: 'A single critical incident with a growing ×N counter', link: 'incidents' },
      { text: 'Sara (East Port) and the NOC are notified once each', link: 'system' },
      { text: 'Reading chart with the threshold band', link: 'devices/cs-ep-01' },
    ],
    guarantee: 'At most one unresolved incident per (rule, device), enforced by a partial unique index in the database. Repeats link evidence; they do not re-notify.',
  },
  {
    title: 'Notification provider outage',
    icon: 'bell',
    story: 'The external notification service goes down just as a hardware fault is reported. Incidents must still open; delivery must catch up afterwards, exactly once.',
    run: {
      label: 'Take provider down + raise fault',
      fn: async () => {
        await notifier('down');
        await sleep(300);
        await sim('devices/gen-cd-01/fault');
      },
      ok: 'Provider down; fault raised on gen-cd-01',
    },
    undo: { label: 'Bring provider back', fn: () => notifier('up'), ok: 'Provider back up — the outbox drains on the next probe' },
    watch: [
      { text: 'The incident opens immediately; notifications show "retrying"', link: 'incidents' },
      { text: 'The circuit breaker opens after 3 failures (Notification dispatcher card)', link: 'system' },
      { text: 'Bring it back: one delivery per operator in the inbox', link: 'system' },
    ],
    guarantee: 'The incident and its notification rows are committed in one transaction (outbox). Delivery is at-least-once with an idempotency key, so the provider drops any repeats.',
  },
  {
    title: 'Duplicate delivery storm',
    icon: 'copy',
    story: 'Four devices re-send 20 events each that the platform has already acknowledged, as firmware does when an ack gets lost.',
    run: {
      label: 'Re-send 80 duplicates',
      fn: () => Promise.all(['cs-nw-02', 'hvac-cd-01', 'cs-sh-01', 'gen-nw-01'].map((d) => sim(`devices/${d}/duplicate`))),
      ok: 'Duplicates on their way',
    },
    watch: [
      { text: 'The blue "Duplicates dropped" series spikes on the throughput chart', link: '' },
      { text: 'No new events and no new incidents are created', link: 'events' },
    ],
    guarantee: 'Idempotent ingest: UNIQUE(device_id, event_id). A duplicate is answered as "duplicate" (so the device can clear it) and is never processed twice.',
  },
  {
    title: 'Ingestion outpaces processing',
    icon: 'layers',
    story: 'The processor is paused while the fleet dumps 6,000 readings at once. Nothing may be lost; the backlog must drain on its own.',
    run: {
      label: 'Pause worker + 6k burst',
      fn: async () => {
        await chaos({ workerPaused: true });
        await sim('burst', { count: 6000 });
      },
      ok: 'Worker paused; burst incoming',
    },
    undo: { label: 'Resume worker', fn: () => chaos({ workerPaused: false }), ok: 'Worker resumed — watch the queue drain' },
    watch: [
      { text: 'Queue depth and "oldest unprocessed" climb; /readyz reports the backlog', link: 'system' },
      { text: 'Devices stay online: liveness is recorded at ingest, not at processing', link: '' },
      { text: 'Resume: the queue drains in seconds', link: 'system' },
    ],
    guarantee: 'Accepted means durably stored. Above the high watermark (20k), ingest answers 429 + Retry-After and devices keep buffering, so load is pushed back to the edge instead of crashing the core.',
  },
  {
    title: 'Poison events → retries → dead-letter',
    icon: 'bug',
    story: 'Every event processing attempt fails for 12 seconds (e.g. a bad deploy). Events retry with exponential backoff, and the ones that run out of attempts are parked.',
    run: {
      label: 'Fail 100% for 12s',
      fn: async () => {
        await chaos({ processingFailureRate: 1 });
        setTimeout(() => chaos({ processingFailureRate: 0 }).then(() => toast('Failure injection ended — retries now succeed', 'ok')), 12_000);
      },
      ok: 'Processing failing for 12s',
    },
    watch: [
      { text: 'Events show "pending ×2, ×3…" in the live stream', link: 'events' },
      { text: 'Most recover once the fault ends; any that exhausted 5 attempts land in the DLQ, ready to re-queue', link: 'system' },
    ],
    guarantee: 'All effects of one event commit in one transaction, so a failure leaves no partial state. Retries are bounded and the DLQ is visible, never silent.',
  },
  {
    title: 'Malformed payloads',
    icon: 'x',
    story: 'A sensor glitch sends a non-numeric temperature and an event with no valid type or timestamp, mixed into a healthy batch.',
    run: { label: 'Send garbage', fn: () => sim('devices/hvac-cd-02/malformed'), ok: 'Malformed events sent from hvac-cd-02' },
    watch: [
      { text: 'Rejected payloads table shows exactly what was wrong', link: 'system' },
      { text: 'The valid events in the same batch were still accepted', link: 'events' },
    ],
    guarantee: 'Validation runs per event. The response lists each rejection with a reason, and the device drops it instead of retrying a poison message forever.',
  },
  {
    title: 'Power loss (no replay)',
    icon: 'power',
    story: 'The Dock Door Sensor loses power: it sends nothing and has nothing to replay. This is the case the silence rule is for.',
    run: { label: 'Power off', fn: () => sim('devices/acc-sh-01/power', { on: false }), ok: 'acc-sh-01 powered off' },
    undo: { label: 'Power on', fn: () => sim('devices/acc-sh-01/power', { on: true }), ok: 'acc-sh-01 powered on' },
    watch: [
      { text: 'Within ~30s a high-severity "stopped reporting" incident opens for James (South Hub)', link: 'incidents' },
      { text: 'Power on: the incident auto-resolves, with the outage duration in the note', link: 'incidents' },
    ],
    guarantee: 'If the platform itself was down, the scanner pauses absence rules and starts a grace window, so a platform outage does not cause an alert storm.',
  },
];

export default function Lab() {
  const devices = useStore((s) => s.devices);
  const conn = useStore((s) => s.conn);
  const { sim: simDevices, chaos: simChaos, setChaos } = useSimDevices();
  const { mode } = useNotifierMode();
  const [busy, run] = useAction();
  const ready = conn === 'live' && simDevices !== null;

  return (
    <>
      <div className="callout accent flex wrap" style={{ gap: 14 }}>
        <Icon name="flask" size={18} color="var(--accent-2)" />
        <div className="grow" style={{ minWidth: 280 }}>
          <b>Every scenario goes through the real system.</b>{' '}
          <span className="text-2">Buttons tell the device simulator or a fault switch what to do. What you then see arrives through the same ingestion API, queue, worker and notifier as normal traffic. Open a second tab on Overview to watch it happen.</span>
        </div>
        <div className="flex small">
          <span className="text-2">Background chaos</span>
          <Toggle on={!!simChaos} disabled={!ready} title="Random disconnects, spikes, lost acks and bad payloads"
            onChange={(v) => run(async () => { await sim('chaos', { enabled: v }); setChaos(v); }, v ? 'Random background faults on' : 'Background faults off — fleet is calm')} />
          <Badge tone={simDevices ? 'ok' : 'danger'} dot>simulator {simDevices ? 'connected' : 'unreachable'}</Badge>
          <Badge tone={mode === 'up' ? 'ok' : 'warn'} dot>notifier {mode ?? '…'}</Badge>
        </div>
      </div>

      <div className="grid g-2-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
        {SCENARIOS.map((s, i) => (
          <section key={s.title} className="panel scenario">
            <div className="flex" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div className="num">{i + 1}</div>
              <div className="grow">
                <h4 className="flex"><Icon name={s.icon} size={15} color="var(--accent-2)" /> {s.title}</h4>
                <p style={{ marginTop: 4 }}>{s.story}</p>
              </div>
            </div>
            <div>
              <div className="section-title" style={{ marginBottom: 4 }}>What to watch</div>
              <ul>
                {s.watch.map((w) => (
                  <li key={w.text}>{w.link !== undefined ? <a style={{ cursor: 'pointer' }} onClick={() => go(w.link!)}>{w.text}</a> : w.text}</li>
                ))}
              </ul>
            </div>
            <div className="small" style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-2)' }}>
              <b style={{ color: 'var(--text)' }}>Guarantee · </b>{s.guarantee}
            </div>
            <div className="flex" style={{ marginTop: 'auto' }}>
              <button className="btn primary" disabled={busy || !ready} onClick={() => run(s.run.fn, s.run.ok)}><Icon name="play" size={13} /> {s.run.label}</button>
              {s.undo && <button className="btn" disabled={busy || !ready} onClick={() => run(s.undo!.fn, s.undo!.ok)}>{s.undo.label}</button>}
            </div>
          </section>
        ))}

        <section className="panel scenario">
          <div className="flex" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div className="num">{SCENARIOS.length + 1}</div>
            <div className="grow">
              <h4 className="flex"><Icon name="refresh" size={15} color="var(--accent-2)" /> Kill processes for real</h4>
              <p style={{ marginTop: 4 }}>The platform runs as separate processes, so you can crash any of them from a terminal:</p>
            </div>
          </div>
          <pre className="code" style={{ fontSize: 11.5 }}>{`# stop the worker mid-stream (events keep being accepted)
pkill -f "src/main.ts worker"
npm run dev:worker   # restarts; expired leases are reclaimed

# stop the API: this dashboard shows "connection lost",
# keeps the last known state, then resumes from Last-Event-ID
pkill -f "src/main.ts api"
npm run dev:api`}</pre>
          <div className="small" style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-2)' }}>
            <b style={{ color: 'var(--text)' }}>Guarantee · </b>Claimed events carry a 30s lease. A crashed worker's events are reclaimed, and lease fencing stops a slow "zombie" worker from committing twice.
          </div>
          {Object.keys(devices).length === 0 && <div className="muted small">No devices registered yet.</div>}
        </section>
      </div>
    </>
  );
}
