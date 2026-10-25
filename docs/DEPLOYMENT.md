# Deployment, monitoring and scaling

## Topology (what ships today)

Four small processes from one image: `api` (stateless HTTP + SSE), `worker` (processor + scanner + dispatcher), `notifier-mock` (stand-in provider; replaced by a real adapter), `simulator` (demo only). State lives in one SQLite file on a volume (`/data`). See `docker-compose.yml`.

## Deploying for a real client

1. **Single site / pilot (works as-is):** one VM or one container host, `docker compose up -d`, the volume on a persistent disk, nightly snapshot plus `sqlite3 .backup` for point-in-time copies. Put Caddy/nginx in front for TLS (disable proxy buffering for `/api/stream`; `X-Accel-Buffering: no` is already sent).
2. **Production (recommended next step):** move storage to **managed Postgres** and replace the claim query with `SELECT … FOR UPDATE SKIP LOCKED`. The lease/fencing, outbox and change-feed logic are unchanged. Then run:
   - `api` ×N behind a load balancer (stateless; each tails the change feed, so SSE works on any replica),
   - `worker` ×M (competing consumers; leases make this safe),
   - one `scanner` leader (or make it idempotent across replicas, which it already nearly is thanks to the partial unique index).
3. **Edge ingestion:** an MQTT broker (e.g. EMQX/AWS IoT Core) bridging into `/api/v1/ingest` for constrained devices; mTLS device certificates instead of bearer keys.
4. **Secrets/config:** all knobs are env vars (`server/src/config.ts`); set `ENROLLMENT_TOKEN`, `NOTIFIER_URL`, thresholds. Replace the mock notifier with an email/SMS/Slack/PagerDuty adapter behind the same `Sender` interface.

## Monitoring

- **Probes:** `/healthz` (liveness), `/readyz` (DB, worker heartbeat, backlog vs watermark; 503 when degraded).
- **Metrics:** `/metrics` (Prometheus): queue depth, oldest-unprocessed age, p95 lag, dead-letter count, devices online/offline, incidents open, notifications pending/dead, accepted/duplicate/rejected. All metrics are prefixed `netwatch_`.
- **Logs:** structured JSON (pino), one line per notable decision: incident opened/re-opened, reconnects, rejections, retries, dead-letters, breaker state. Ship to Loki/ELK/CloudWatch.
- **Suggested alerts:** `netwatch_queue_oldest_age_seconds > 60` for 5m; `netwatch_dead_letter_events > 0`; `netwatch_notifications_dead > 0`; `readyz` failing; devices offline ratio > 20%.
- **"Why did / didn't this fire?"** Event drawer → decision trace (every rule's outcome and reason, persisted in `rule_evaluations`).

## Scaling levers

| Bottleneck        | Lever                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Ingest CPU        | More `api` replicas                                                                                          |
| Processing        | More `worker` replicas (after Postgres); raise `WORKER_BATCH_SIZE`                                           |
| Single-writer DB  | Postgres; partition `events` by time; archive processed events to object storage                             |
| Burst absorption  | Already pushed to the edge via 429 + device buffers; add a broker for very large fleets                      |
| Dashboard fan-out | SSE clients are cheap; put a CDN/edge in front of static assets; per-location subscriptions if payloads grow |

## Rollout / ops notes

Graceful shutdown (SIGTERM) lets the in-flight batch finish; unfinished leases are reclaimed within `WORKER_LEASE_MS`. Deploy workers and APIs independently; devices simply retry through a restart.
