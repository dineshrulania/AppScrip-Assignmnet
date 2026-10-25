/**
 * NetWatch device simulator.
 *
 * Each virtual device behaves like real firmware with a store-and-forward buffer:
 *   - generates telemetry + discrete events, each with a unique event_id (`<boot_id>-<seq>`)
 *   - appends every event to a local buffer first, then uploads in batches
 *   - only drops events from the buffer once the platform has answered 2xx (ack)
 *   - on network loss / 5xx / 429 it keeps buffering and retries with backoff + jitter
 *   - on reconnect it replays the buffer oldest-first (=> late, possibly duplicated events)
 *
 * Realistic faults are injected on purpose: lost acks (=> duplicates), shuffled batches
 * (=> out-of-order), malformed payloads, random disconnects, temperature excursions.
 *
 * A small control API (default :4100) lets the dashboard drive scenarios.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const ENROLLMENT_TOKEN = process.env.ENROLLMENT_TOKEN ?? 'dev-enrollment-token';
const CONTROL_PORT = Number(process.env.SIM_PORT ?? 4100);
const TICK_MS = Number(process.env.SIM_TICK_MS ?? 2000);
const BUFFER_MAX = Number(process.env.SIM_BUFFER_MAX ?? 5000);
const BATCH = 100;
let chaos = process.env.SIM_CHAOS !== '0';

type Kind = 'cold_storage' | 'hvac' | 'generator' | 'access';
type Mode = 'online' | 'offline' | 'powered_off';

interface SimEvent {
  event_id: string;
  seq: number;
  boot_id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

const FLEET: { id: string; name: string; location: string; type: Kind }[] = [
  { id: 'cs-nw-01', name: 'Cold Store Unit A', location: 'North Warehouse', type: 'cold_storage' },
  { id: 'cs-nw-02', name: 'Cold Store Unit B', location: 'North Warehouse', type: 'cold_storage' },
  { id: 'gen-nw-01', name: 'Backup Generator', location: 'North Warehouse', type: 'generator' },
  { id: 'cs-ep-01', name: 'Reefer Bay 1', location: 'East Port', type: 'cold_storage' },
  { id: 'cs-ep-02', name: 'Reefer Bay 2', location: 'East Port', type: 'cold_storage' },
  { id: 'acc-ep-01', name: 'Gate A Access Panel', location: 'East Port', type: 'access' },
  { id: 'hvac-cd-01', name: 'Server Hall CRAC-1', location: 'Central DC', type: 'hvac' },
  { id: 'hvac-cd-02', name: 'Server Hall CRAC-2', location: 'Central DC', type: 'hvac' },
  { id: 'gen-cd-01', name: 'DG Set 1', location: 'Central DC', type: 'generator' },
  { id: 'cs-sh-01', name: 'Pharma Cold Room 1', location: 'South Hub', type: 'cold_storage' },
  { id: 'hvac-sh-01', name: 'Dispatch Hall AC', location: 'South Hub', type: 'hvac' },
  { id: 'acc-sh-01', name: 'Dock Door Sensor', location: 'South Hub', type: 'access' },
];

const BASELINE: Record<Kind, { temp: number; spike: number; jitter: number }> = {
  cold_storage: { temp: 4, spike: 11, jitter: 0.25 },
  hvac: { temp: 23, spike: 34, jitter: 0.3 },
  generator: { temp: 78, spike: 101, jitter: 0.8 },
  access: { temp: 28, spike: 28, jitter: 0.2 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

class Device {
  key = '';
  bootId = crypto.randomBytes(3).toString('hex');
  seq = 0;
  mode: Mode = 'online';
  buffer: SimEvent[] = [];
  dropped = 0;
  temp: number;
  humidity = rand(40, 60);
  battery = rand(55, 100);
  spikeUntil = 0;
  offlineUntil = 0;
  sent = 0;
  duplicatesSent = 0;
  lastAck: string | null = null;
  lastError: string | null = null;
  backoffUntil = 0;
  backoffMs = 0;
  recentlySent: SimEvent[] = [];
  private flushing = false;

  constructor(public def: (typeof FLEET)[number]) {
    this.temp = BASELINE[def.type].temp + rand(-0.5, 0.5);
    if (def.id === 'acc-sh-01') this.battery = 19; // drains into the low-battery rule during a demo
  }

  async register() {
    const res = await fetch(`${API}/api/v1/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-enrollment-token': ENROLLMENT_TOKEN },
      body: JSON.stringify({ device_id: this.def.id, name: this.def.name, location: this.def.location, type: this.def.type }),
    });
    if (!res.ok) throw new Error(`register ${this.def.id}: ${res.status}`);
    this.key = ((await res.json()) as { device_key: string }).device_key;
  }

  emit(type: string, payload: Record<string, unknown>, ts = Date.now()) {
    this.seq++;
    this.buffer.push({ event_id: `${this.bootId}-${this.seq}`, seq: this.seq, boot_id: this.bootId, type, ts, payload });
    if (this.buffer.length > BUFFER_MAX) {
      // Bounded memory, like real firmware: drop the oldest and report the loss when we can.
      this.buffer.shift();
      this.dropped++;
    }
  }

  tick() {
    if (this.mode === 'powered_off') return;
    const now = Date.now();
    if (this.mode === 'offline' && now >= this.offlineUntil) this.goOnline();

    const base = BASELINE[this.def.type];
    if (chaos && this.def.type !== 'access' && Math.random() < 0.0015) this.spikeUntil = now + rand(10_000, 20_000);
    const target = now < this.spikeUntil ? base.spike : base.temp;
    this.temp += (target - this.temp) * (now < this.spikeUntil ? 0.35 : 0.2) + rand(-base.jitter, base.jitter);
    this.humidity = Math.min(95, Math.max(20, this.humidity + rand(-0.6, 0.6)));
    this.battery = Math.max(0, this.battery - rand(0, this.def.type === 'access' ? 0.05 : 0.01));

    const payload: Record<string, unknown> = { temperature: round(this.temp), battery: round(this.battery, 1) };
    if (this.def.type !== 'access') payload.humidity = round(this.humidity, 1);
    if (this.def.type === 'generator') payload.rpm = Math.round(rand(1480, 1520));

    // Occasionally corrupt a reading the way flaky sensors do.
    if (chaos && Math.random() < 0.003) payload.temperature = 'ERR';
    this.emit('telemetry', payload);

    if (this.def.type === 'access' && Math.random() < 0.08) this.emit('door_open', { door: 'main', duration_s: Math.round(rand(2, 40)) });
    if (chaos && Math.random() < 0.0006) this.emit('fault', { code: 'E' + Math.floor(rand(100, 999)), message: 'compressor overcurrent' });
    if (chaos && this.def.type === 'access' && Math.random() < 0.002) this.emit('tamper', { sensor: 'enclosure' });
    if (this.dropped && this.mode === 'online') {
      this.emit('buffer_overflow', { dropped: this.dropped });
      this.dropped = 0;
    }

    // Random network loss. The device keeps generating and buffering.
    if (chaos && this.mode === 'online' && Math.random() < 0.0012) this.goOffline(rand(25, 75));
  }

  goOffline(seconds: number) {
    if (this.mode === 'powered_off') return;
    this.mode = 'offline';
    this.offlineUntil = Date.now() + seconds * 1000;
    log(`${this.def.id} lost connectivity for ${Math.round(seconds)}s (buffering locally)`);
  }

  goOnline() {
    if (this.mode === 'online') return;
    const was = this.mode;
    this.mode = 'online';
    this.offlineUntil = 0;
    log(`${this.def.id} back online (${was}); ${this.buffer.length} buffered event(s) to replay`);
  }

  powerOff() {
    this.mode = 'powered_off';
    log(`${this.def.id} powered off (silent; no buffering)`);
  }

  reboot() {
    this.bootId = crypto.randomBytes(3).toString('hex');
    this.seq = 0;
    this.mode = 'online';
    this.emit('boot', { reason: 'operator reboot' });
    log(`${this.def.id} rebooted, new boot_id ${this.bootId}`);
  }

  async flush() {
    if (this.flushing || this.mode !== 'online' || !this.buffer.length || Date.now() < this.backoffUntil) return;
    this.flushing = true;
    try {
      while (this.mode === 'online' && this.buffer.length) {
        const batch = this.buffer.slice(0, BATCH);
        const replaying = batch.length > 5;
        // Real networks reorder; shuffle some replay batches to exercise out-of-order handling.
        const wire = chaos && replaying && Math.random() < 0.5 ? [...batch].sort(() => Math.random() - 0.5) : batch;
        const res = await this.post(wire);
        if (res === 'retry') return;
        // Lost ack: the server stored the batch but we never heard back -> we resend it (duplicates).
        if (chaos && Math.random() < 0.02) {
          this.duplicatesSent += batch.length;
          log(`${this.def.id} ack lost for ${batch.length} event(s); will resend (server must de-duplicate)`);
          continue;
        }
        this.buffer.splice(0, batch.length);
        this.recentlySent = [...this.recentlySent, ...batch].slice(-50);
        this.sent += batch.length;
        this.backoffMs = 0;
      }
    } finally {
      this.flushing = false;
    }
  }

  private async post(events: unknown[]): Promise<'ok' | 'retry'> {
    try {
      const res = await fetch(`${API}/api/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        await this.register(); // key rotated / platform DB reset: re-enrol and retry
        return 'retry';
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
        this.scheduleRetry(`HTTP ${res.status}`, retryAfter);
        return 'retry';
      }
      if (!res.ok) {
        // 4xx other than 401/429 means the batch itself is unacceptable; drop it rather than loop forever.
        this.lastError = `HTTP ${res.status}: ${await res.text()}`;
        return 'ok';
      }
      this.lastAck = new Date().toISOString();
      this.lastError = null;
      return 'ok';
    } catch (err) {
      this.scheduleRetry((err as Error).message);
      return 'retry';
    }
  }

  private scheduleRetry(reason: string, minMs = 0) {
    this.backoffMs = Math.min(30_000, Math.max(1000, this.backoffMs * 2));
    const wait = Math.max(minMs, this.backoffMs * rand(0.5, 1.0)); // full jitter avoids a thundering herd
    this.backoffUntil = Date.now() + wait;
    if (this.lastError !== reason) log(`${this.def.id} upload failed (${reason}); retrying in ${Math.round(wait)}ms with ${this.buffer.length} buffered`);
    this.lastError = reason;
  }

  status() {
    return {
      id: this.def.id, name: this.def.name, location: this.def.location, type: this.def.type,
      mode: this.mode, buffered: this.buffer.length, dropped: this.dropped, seq: this.seq, boot_id: this.bootId,
      temperature: round(this.temp), battery: round(this.battery, 1), spiking: Date.now() < this.spikeUntil,
      offline_for_s: this.mode === 'offline' ? Math.max(0, Math.round((this.offlineUntil - Date.now()) / 1000)) : 0,
      sent: this.sent, duplicates_sent: this.duplicatesSent, last_ack: this.lastAck, last_error: this.lastError,
    };
  }
}

const log = (msg: string) => console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const devices = new Map<string, Device>();

async function main() {
  for (const def of FLEET) devices.set(def.id, new Device(def));
  for (;;) {
    try {
      await Promise.all([...devices.values()].map((d) => d.register()));
      break;
    } catch (e) {
      log(`waiting for platform at ${API} (${(e as Error).message})`);
      await sleep(2000);
    }
  }
  log(`registered ${devices.size} devices; chaos=${chaos ? 'on' : 'off'}; control API on :${CONTROL_PORT}`);

  // Stagger device clocks so traffic is smooth rather than lock-step.
  for (const d of devices.values()) {
    setTimeout(() => setInterval(() => d.tick(), TICK_MS), rand(0, TICK_MS));
  }
  setInterval(() => devices.forEach((d) => void d.flush()), 250);
}

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

const reply = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return reply(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/devices') return reply(res, 200, { chaos, devices: [...devices.values()].map((d) => d.status()) });
    if (req.method === 'POST' && url.pathname === '/chaos') {
      chaos = !!body.enabled;
      log(`random chaos ${chaos ? 'enabled' : 'disabled'}`);
      return reply(res, 200, { chaos });
    }
    if (req.method === 'POST' && url.pathname === '/burst') {
      // Sudden burst: every device dumps N historical readings at once.
      const count = Math.min(20_000, Number(body.count) || 3000);
      const per = Math.ceil(count / devices.size);
      const now = Date.now();
      for (const d of devices.values()) {
        for (let i = per; i > 0; i--) d.emit('telemetry', { temperature: round(d.temp + rand(-0.3, 0.3)), battery: round(d.battery, 1) }, now - i * 50);
      }
      log(`burst: queued ${per * devices.size} events across the fleet`);
      return reply(res, 200, { queued: per * devices.size });
    }

    if (parts[0] === 'devices' && parts[1] && req.method === 'POST') {
      const d = devices.get(parts[1]);
      if (!d) return reply(res, 404, { error: 'unknown device' });
      switch (parts[2]) {
        case 'offline': d.goOffline(Number(body.seconds) || 60); break;
        case 'online': d.goOnline(); break;
        case 'power': body.on === false ? d.powerOff() : d.goOnline(); break;
        case 'spike': d.spikeUntil = Date.now() + (Number(body.seconds) || 20) * 1000; log(`${d.def.id} temperature excursion`); break;
        case 'fault': d.emit('fault', { code: 'E501', message: 'compressor overcurrent (manual)' }); break;
        case 'tamper': d.emit('tamper', { sensor: 'enclosure (manual)' }); break;
        case 'reboot': d.reboot(); break;
        case 'malformed':
          d.emit('telemetry', { temperature: 'NaN-sensor-error' });
          d.buffer.push({ event_id: '', type: 'Bad Type!', ts: 'yesterday' } as any);
          break;
        case 'duplicate': {
          const again = d.recentlySent.slice(-20);
          d.buffer.unshift(...again);
          d.duplicatesSent += again.length;
          log(`${d.def.id} re-sending ${again.length} already-acked event(s)`);
          break;
        }
        default: return reply(res, 404, { error: 'unknown action' });
      }
      return reply(res, 200, d.status());
    }
    reply(res, 404, { error: 'not found' });
  })
  .listen(CONTROL_PORT);

main();
