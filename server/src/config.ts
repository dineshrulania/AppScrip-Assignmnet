// Central configuration. Every knob can be overridden by an environment variable so the
// same build runs locally, in docker-compose and in a container platform.

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? new URL('../data/netwatch.db', import.meta.url).pathname,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  serveWeb: process.env.SERVE_WEB === '1',

  /** Shared secret a device presents once to obtain its own per-device key. */
  enrollmentToken: process.env.ENROLLMENT_TOKEN ?? 'dev-enrollment-token',

  ingest: {
    maxBatch: num('INGEST_MAX_BATCH', 500),
    /** Pending-queue depth above which ingestion answers 429 + Retry-After (backpressure). */
    highWatermark: num('INGEST_HIGH_WATERMARK', 20_000),
    /** An event is "late" if it reaches us this long after it happened (offline replay). */
    lateAfterMs: num('INGEST_LATE_AFTER_MS', 30_000),
    /** Events claiming to be from further in the future than this are rejected (clock skew). */
    maxFutureSkewMs: num('INGEST_MAX_FUTURE_SKEW_MS', 5 * 60_000),
    /** Events older than this are rejected - outside the retention window anyway. */
    maxAgeMs: num('INGEST_MAX_AGE_MS', 7 * 24 * 3600_000),
  },

  worker: {
    batchSize: num('WORKER_BATCH_SIZE', 200),
    pollMs: num('WORKER_POLL_MS', 100),
    /** A claimed event whose lease expires (worker crashed) becomes claimable again. */
    leaseMs: num('WORKER_LEASE_MS', 30_000),
    maxAttempts: num('WORKER_MAX_ATTEMPTS', 5),
    retryBaseMs: num('WORKER_RETRY_BASE_MS', 1_000),
  },

  scanner: {
    intervalMs: num('SCANNER_INTERVAL_MS', 2_000),
    /** No traffic for this long => device shown as offline. */
    offlineAfterMs: num('DEVICE_OFFLINE_AFTER_MS', 20_000),
  },

  notifier: {
    url: process.env.NOTIFIER_URL ?? 'http://localhost:4200/notify',
    pollMs: num('NOTIFIER_POLL_MS', 500),
    timeoutMs: num('NOTIFIER_TIMEOUT_MS', 3_000),
    maxAttempts: num('NOTIFIER_MAX_ATTEMPTS', 12),
    retryBaseMs: num('NOTIFIER_RETRY_BASE_MS', 1_000),
    retryMaxMs: num('NOTIFIER_RETRY_MAX_MS', 60_000),
    breakerThreshold: num('NOTIFIER_BREAKER_THRESHOLD', 3),
    breakerCooldownMs: num('NOTIFIER_BREAKER_COOLDOWN_MS', 10_000),
  },

  changes: {
    pollMs: num('CHANGES_POLL_MS', 150),
    retentionMs: num('CHANGES_RETENTION_MS', 60 * 60_000),
  },

  simulatorUrl: process.env.SIMULATOR_URL ?? 'http://localhost:4100',
};

export type Config = typeof config;
