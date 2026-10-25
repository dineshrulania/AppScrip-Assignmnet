import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/**
 * SQLite in WAL mode is the single source of truth AND the durable queue.
 *
 * - `events` doubles as the inbox: rows are inserted as `pending` in the same
 *   transaction that de-duplicates them, so an accepted event can never be lost.
 * - `notifications` is a transactional outbox: written in the same transaction
 *   that opens an incident, delivered later by the dispatcher.
 * - `changes` is an append-only change feed the API tails to push live updates
 *   (and lets reconnecting dashboards resume from their last seen id).
 */
const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  location        TEXT NOT NULL,
  type            TEXT NOT NULL,
  key_hash        TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,            -- server clock, updated at ingest (not processing) time
  last_event_ts   INTEGER,            -- device clock of the newest event processed
  last_seq        INTEGER,
  boot_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown',  -- online | offline | unknown
  status_since    INTEGER,
  latest          TEXT NOT NULL DEFAULT '{}',       -- newest reading per metric (JSON)
  events_total    INTEGER NOT NULL DEFAULT 0,
  duplicates_total INTEGER NOT NULL DEFAULT 0,
  late_total      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL REFERENCES devices(id),
  event_id        TEXT NOT NULL,
  seq             INTEGER,
  type            TEXT NOT NULL,
  ts              INTEGER NOT NULL,   -- when it happened (device clock)
  received_at     INTEGER NOT NULL,   -- when we accepted it (server clock)
  payload         TEXT NOT NULL,
  late            INTEGER NOT NULL DEFAULT 0,
  out_of_order    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | processing | processed | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  lease_until     INTEGER,
  last_error      TEXT,
  processed_at    INTEGER,
  UNIQUE (device_id, event_id)        -- idempotency: the same event is stored once
);
CREATE INDEX IF NOT EXISTS events_queue ON events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS events_device_ts ON events(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at DESC);

-- Connectivity history (online/offline/reconnect/reboot) for the activity feed.
CREATE TABLE IF NOT EXISTS device_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_log_at ON device_log(at DESC);

CREATE TABLE IF NOT EXISTS rejected_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  device_id   TEXT,
  reason      TEXT NOT NULL,
  raw         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  email     TEXT NOT NULL,
  locations TEXT NOT NULL DEFAULT '[]',   -- JSON array; ["*"] = every location
  min_severity TEXT NOT NULL DEFAULT 'low'
);

CREATE TABLE IF NOT EXISTS rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- threshold | absence | event_type
  enabled      INTEGER NOT NULL DEFAULT 1,
  severity     TEXT NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  config       TEXT NOT NULL,             -- JSON, shape depends on kind
  scope        TEXT NOT NULL DEFAULT '{}',-- JSON {device_types?, locations?, device_ids?}
  cooldown_sec INTEGER NOT NULL DEFAULT 120,
  auto_resolve INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id          INTEGER NOT NULL REFERENCES rules(id),
  device_id        TEXT NOT NULL REFERENCES devices(id),
  dedup_key        TEXT NOT NULL,
  status           TEXT NOT NULL,         -- open | acknowledged | resolved
  severity         TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  opened_at        INTEGER NOT NULL,
  last_triggered_at INTEGER NOT NULL,
  last_event_ts    INTEGER,               -- device time of the newest matching event
  trigger_count    INTEGER NOT NULL DEFAULT 1,
  condition_active INTEGER NOT NULL DEFAULT 1,
  detected_late    INTEGER NOT NULL DEFAULT 0,
  acknowledged_at  INTEGER,
  acknowledged_by  TEXT,
  resolved_at      INTEGER,
  resolved_by      TEXT,
  resolution_note  TEXT,
  assignee         TEXT,
  version          INTEGER NOT NULL DEFAULT 1
);
-- The heart of incident de-duplication: at most ONE unresolved incident per (rule, device),
-- enforced by the database even if several workers race on the same device.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_active
  ON incidents(dedup_key) WHERE status != 'resolved';
CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, last_triggered_at DESC);

CREATE TABLE IF NOT EXISTS incident_events (
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  event_pk    INTEGER NOT NULL REFERENCES events(id),
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (incident_id, event_pk)
);

CREATE TABLE IF NOT EXISTS incident_timeline (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS timeline_incident ON incident_timeline(incident_id, at);

-- Decision log: answers "why was (or wasn't) an incident created for this event?"
CREATE TABLE IF NOT EXISTS rule_evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_pk    INTEGER,
  rule_id     INTEGER NOT NULL,
  device_id   TEXT NOT NULL,
  at          INTEGER NOT NULL,
  outcome     TEXT NOT NULL,   -- matched | not_matched | out_of_scope | linked | reopened | cleared
  reason      TEXT NOT NULL,
  incident_id INTEGER
);
CREATE INDEX IF NOT EXISTS evals_event ON rule_evaluations(event_pk);
CREATE INDEX IF NOT EXISTS evals_rule ON rule_evaluations(rule_id, at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id     INTEGER NOT NULL REFERENCES incidents(id),
  operator_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,          -- opened | reopened | escalated
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS changes (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  topic TEXT NOT NULL,
  data  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  component TEXT PRIMARY KEY,
  pid       INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  beat_at   INTEGER NOT NULL,
  info      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-second ingest counters, kept so throughput charts survive restarts.
CREATE TABLE IF NOT EXISTS ingest_stats (
  bucket     INTEGER PRIMARY KEY,  -- unix seconds
  accepted   INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  rejected   INTEGER NOT NULL DEFAULT 0,
  late       INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 5000 }); // api + worker processes share the file
  db.pragma('busy_timeout = 5000'); // must come first: two processes may initialise the file at once
  // Readers never block the writer; multi-process safe. Switching modes can report SQLITE_BUSY
  // without consulting the busy handler when another process is initialising, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      db.pragma('journal_mode = WAL');
      break;
    } catch (err: any) {
      if (err?.code !== 'SQLITE_BUSY' || attempt >= 50) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  db.pragma('synchronous = NORMAL'); // durable across process crashes; fsync at checkpoints
  db.pragma('foreign_keys = ON');
  db.transaction(() => db.exec(SCHEMA)).immediate();
  return db;
}

/** Run `fn` inside BEGIN IMMEDIATE so concurrent writers serialize instead of deadlocking. */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
