import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Device, FleetEvent, Incident, Rule, SeriesPoint, Stats } from './types';

/**
 * Live client state.
 *
 * - A snapshot is loaded over REST; the SSE stream then applies deltas (idempotent upserts by id).
 * - The browser's EventSource resends `Last-Event-ID` on reconnect, so the server replays exactly
 *   what we missed. If the gap is too old the server says `reset` and we reload the snapshot.
 * - The last good snapshot is cached in localStorage so a reload during an outage still shows
 *   the last known state (clearly marked as stale).
 * - Deltas are coalesced per animation frame so a replay burst of thousands of events doesn't
 *   re-render the page thousands of times.
 */

export type Conn = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface State {
  conn: Conn;
  connSince: number;
  lastMessageAt: number | null;
  lastSyncAt: number | null;
  fromCache: boolean;
  resume: { mode: string; replayed: number; at: number } | null;
  devices: Record<string, Device>;
  events: FleetEvent[];
  incidents: Record<number, Incident>;
  rules: Rule[];
  stats: Stats | null;
  series: SeriesPoint[];
  bursts: { device_id: string; accepted: number; late: number; at: number }[];
  pulse: number; // increments on every applied change; drives subtle "live" animations
}

const MAX_EVENTS = 400;
const CACHE_KEY = 'netwatch:snapshot:v1';

let state: State = {
  conn: 'connecting',
  connSince: Date.now(),
  lastMessageAt: null,
  lastSyncAt: null,
  fromCache: false,
  resume: null,
  devices: {},
  events: [],
  incidents: {},
  rules: [],
  stats: null,
  series: [],
  bursts: [],
  pulse: 0,
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => selector(state),
  );
}
export const getState = () => state;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export async function loadSnapshot() {
  const [devices, incidents, events, rules, stats, series] = await Promise.all([
    api.get<Device[]>('/api/devices'),
    api.get<Incident[]>('/api/incidents?status=all&limit=300'),
    api.get<FleetEvent[]>(`/api/events?limit=${MAX_EVENTS}`),
    api.get<Rule[]>('/api/rules'),
    api.get<Stats>('/api/stats'),
    api.get<{ points: SeriesPoint[] }>('/api/stats/timeseries?minutes=15'),
  ]);
  set({
    devices: Object.fromEntries(devices.map((d) => [d.id, d])),
    incidents: Object.fromEntries(incidents.map((i) => [i.id, i])),
    events,
    rules,
    stats,
    series: series.points,
    lastSyncAt: Date.now(),
    fromCache: false,
  });
  saveCache();
}

export async function refreshRules() {
  set({ rules: await api.get<Rule[]>('/api/rules') });
}

async function refreshSeries() {
  try {
    const s = await api.get<{ points: SeriesPoint[] }>('/api/stats/timeseries?minutes=15');
    set({ series: s.points });
  } catch {
    /* offline: keep the last series */
  }
}

function saveCache() {
  try {
    const { devices, incidents, events, rules, stats, series, lastSyncAt } = state;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ devices, incidents, events: events.slice(0, 100), rules, stats, series, lastSyncAt }));
  } catch {
    /* storage full / disabled: caching is best-effort */
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) set({ ...JSON.parse(raw), fromCache: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

type Delta = { topic: string; data: any };
let queue: Delta[] = [];
let scheduled = false;

function enqueue(d: Delta) {
  queue.push(d);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  if (!batch.length) return;

  let devices = state.devices;
  let incidents = state.incidents;
  let events = state.events;
  let bursts = state.bursts;
  let rulesDirty = false;
  const newEvents: FleetEvent[] = [];
  const eventPatches = new Map<number, Partial<FleetEvent>>();

  for (const { topic, data } of batch) {
    if (topic === 'device' && data?.id) {
      if (devices === state.devices) devices = { ...devices };
      devices[data.id] = { ...devices[data.id], ...data };
    } else if (topic === 'incident' && data?.id) {
      if (incidents === state.incidents) incidents = { ...incidents };
      incidents[data.id] = data;
    } else if (topic === 'event') {
      newEvents.push(data);
    } else if (topic === 'event.processed') {
      eventPatches.set(data.id, { ...eventPatches.get(data.id), ...data });
    } else if (topic === 'rule') {
      rulesDirty = true;
    } else if (topic === 'system' && data?.kind === 'burst') {
      bursts = [{ ...data, at: Date.now() }, ...bursts].slice(0, 8);
    }
  }

  if (newEvents.length || eventPatches.size) {
    const seen = new Set(events.map((e) => e.id));
    const fresh = newEvents.filter((e) => !seen.has(e.id)).reverse();
    events = [...fresh, ...events].slice(0, MAX_EVENTS);
    if (eventPatches.size) events = events.map((e) => (eventPatches.has(e.id) ? { ...e, ...eventPatches.get(e.id) } : e));
  }

  set({ devices, incidents, events, bursts, pulse: state.pulse + batch.length, lastMessageAt: Date.now() });
  if (rulesDirty) void refreshRules();
}

let source: EventSource | null = null;
let lastId: string | null = null;
let retryTimer: number | undefined;
let retryDelay = 1000;

export function connect() {
  loadCache();
  open();
  setInterval(() => state.conn === 'live' && refreshSeries(), 10_000);
  setInterval(() => state.conn === 'live' && saveCache(), 5000);
  // Detect a silently dead connection (proxy dropped it without closing the socket).
  setInterval(() => {
    if (state.conn === 'live' && state.lastMessageAt && Date.now() - state.lastMessageAt > 20_000) {
      source?.close();
      scheduleReconnect();
    }
  }, 5000);
}

function open() {
  source?.close();
  const es = new EventSource(lastId ? `/api/stream?since=${lastId}` : '/api/stream');
  source = es;

  es.addEventListener('hello', async (e) => {
    const msg = JSON.parse((e as MessageEvent).data);
    lastId = (e as MessageEvent).lastEventId || lastId;
    retryDelay = 1000;
    const wasDown = state.conn === 'reconnecting' || state.conn === 'offline';
    set({ conn: 'live', connSince: Date.now(), lastMessageAt: Date.now() });
    if (msg.mode !== 'resumed' || state.fromCache || !state.lastSyncAt) {
      try {
        await loadSnapshot();
      } catch {
        /* the stream is up but REST failed; the next hello retries */
      }
    }
    if (wasDown || msg.mode === 'resumed') set({ resume: { mode: msg.mode, replayed: msg.replayed, at: Date.now() } });
  });

  for (const topic of ['event', 'event.processed', 'device', 'incident', 'notification', 'rule', 'system']) {
    es.addEventListener(topic, (e) => {
      const me = e as MessageEvent;
      if (me.lastEventId) lastId = me.lastEventId;
      enqueue({ topic, data: JSON.parse(me.data) });
    });
  }
  es.addEventListener('stats', (e) => set({ stats: JSON.parse((e as MessageEvent).data), lastMessageAt: Date.now() }));

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
    else if (state.conn !== 'reconnecting') set({ conn: 'reconnecting', connSince: Date.now() });
  };
}

function scheduleReconnect() {
  set({ conn: state.conn === 'live' ? 'reconnecting' : 'offline', connSince: state.conn === 'live' ? Date.now() : state.connSince });
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(open, retryDelay);
  retryDelay = Math.min(15_000, retryDelay * 2);
}

export function upsertIncident(i: Incident) {
  set({ incidents: { ...state.incidents, [i.id]: i } });
}
