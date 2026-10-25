# NetWatch: Real-Time Device Monitoring Platform

Monitor a distributed network of devices in real time, detect anomalies with operator-defined rules, and manage the resulting incidents — while staying correct when devices disconnect, events duplicate or arrive late, workers crash, or the notification provider is down.

**Stack:** Node 22 · TypeScript · Fastify · SQLite (WAL) · React + Vite · Server-Sent Events. Zero external services.

## Run it (2 minutes)

```bash
npm install
npm run dev          # API :4000 · worker · notifier mock :4200 · simulator :4100 · dashboard :5173
```

Open **http://localhost:5173**. The simulator registers 12 devices across 4 sites and starts producing traffic immediately.

- Production-style single port: `npm start` then http://localhost:4000
- Docker: `docker compose up --build` then http://localhost:4000
- Tests: `npm test` (42 tests, in-memory DB, fake clock, no sleeps)
- Reset state: `npm run reset`

## 5-minute evaluation tour

1. **Overview:** live KPIs, throughput chart (accepted / late / duplicate / rejected), fleet by location, activity feed.
2. **Failure lab** (sidebar): 7 one-click scenarios (network loss + replay, temperature excursion, provider outage, duplicate storm, backlog, poison events, malformed payloads, power loss), each with _what to watch_ and _the guarantee_.
3. **Incidents:** open one. See _why it exists_, timeline, notification delivery status, linked evidence events. Acknowledge and resolve.
4. **Live events:** click any event for the **decision trace**: every rule's outcome and reason. This answers "why was / wasn't an incident created?".
5. **Rules:** create one; the dry run shows what it would have matched in the last hour of real traffic.
6. **System health:** per-process heartbeats, queue/lag, dead-letter queue with re-queue, fault injection, the operator inbox.
7. **Kill things for real:** stop the worker, restart it, and nothing is lost. Stop the API and the dashboard goes stale with a banner, then resumes and reports what it caught up on.

## Repository map

```
server/src/   ingest.ts (validate/dedupe/backpressure) · worker.ts (lease, retry, DLQ, fencing)
              rules.ts (pure evaluation) · incidents.ts (dedup, lifecycle, outbox routing)
              scanner.ts (offline/absence) · notify/ (dispatcher + circuit breaker + mock provider)
              app.ts (REST + SSE hub) · db.ts (schema) · stats.ts (metrics)
server/test/  42 tests: ingestion, rules, incidents, reliability/failures, scanner, API + stream resume
simulator/    device firmware simulator with offline buffer, replay, duplicates, bad payloads
web/src/      store.ts (snapshot + SSE deltas + resume + cache) · pages/ · components/
docs/         ARCHITECTURE.md · PROTOCOL.md · DEPLOYMENT.md
```

## Documentation

- [Architecture notes](docs/ARCHITECTURE.md): diagram, decisions, alternatives, trade-offs, guarantees, limitations
- [Device protocol](docs/PROTOCOL.md): schema, identity, duplicates, delay, reconnection
- [Deployment & scaling](docs/DEPLOYMENT.md): deploy, monitor, scale for a real client

## Guarantees in one paragraph

"Accepted" means durably stored. Processing is at-least-once with idempotent effects (unique `(device, event_id)`, one transaction per event, lease + fencing), so the visible result is effectively-once. There is at most one unresolved incident per (rule, device), enforced by a partial unique index. Incidents and their notifications commit atomically (outbox); delivery retries with backoff behind a circuit breaker and is de-duplicated by idempotency key. Overload is pushed back to devices with `429 + Retry-After`. Dashboards resume exactly from `Last-Event-ID`. Limitations are listed honestly in the architecture notes (notably: single-node SQLite, no dashboard auth).

## Observability

`/healthz` · `/readyz` · `/metrics` (Prometheus) · structured JSON logs (`LOG_FORMAT=json`, `LOG_LEVEL`) · decision log per event · dead-letter and rejected-payload views.

## Configuration

All via env vars, see [server/src/config.ts](server/src/config.ts) (ports, thresholds, lease/retry timings, watermark, offline window).
