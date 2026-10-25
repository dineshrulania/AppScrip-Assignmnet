# Device protocol

Transport: HTTPS `POST` with JSON. The device owns a local store-and-forward buffer and the platform answers every batch explicitly.

## Identity

1. **Enrol once:** `POST /api/v1/devices/register` with header `X-Enrollment-Token` and `{device_id, name?, location, type}` returns `{device_id, device_key}`. The key is stored hashed (SHA-256); re-registering rotates it.
2. **Every request:** `Authorization: Bearer <device_key>`. The platform derives the device from the key, so a device cannot write as another (a mismatching `device_id` in an event is rejected). A `401` tells the device to re-enrol.

## Event

```json
{
  "event_id": "a1b2c3-42",
  "seq": 42,
  "boot_id": "a1b2c3",
  "type": "telemetry",
  "ts": 1792943592230,
  "payload": { "temperature": 4.21, "battery": 91.5 }
}
```

| Field            | Rules                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `event_id`       | Required, unique per device, **stable across retries** (`<boot_id>-<seq>`). The idempotency key. |
| `seq`, `boot_id` | Optional. Monotonic counter per boot; a new `boot_id` signals a reboot (logged).                 |
| `type`           | Lowercase identifier (`telemetry`, `fault`, `tamper`, `door_open`, …).                           |
| `ts`             | When it **happened** on the device: epoch ms or ISO-8601. Not the send time.                     |
| `payload`        | Object ≤16KB. `telemetry` payloads must be finite numbers.                                       |

## Upload

`POST /api/v1/ingest` with `{"events":[…]}` (or a bare array/event), max 500 per batch.

Response `200`:

```json
{
  "accepted": 1,
  "duplicates": 1,
  "rejected": [
    {
      "index": 2,
      "event_id": "x",
      "errors": ["payload.temperature: must be a finite number"]
    }
  ],
  "results": ["accepted", "duplicate", "rejected"]
}
```

**Device rule:** on any `2xx`, drop **every** event of the batch from the buffer, because all three outcomes are final. On `429`/`5xx`/timeout/network error, keep the batch and retry with exponential backoff + jitter, honouring `Retry-After`.

## How the hard cases are handled

| Case                               | Behaviour                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duplicates** (lost ack → resend) | `UNIQUE(device_id, event_id)`; reported as `duplicate`, never reprocessed.                                                                                                    |
| **Delayed delivery**               | `ts` is preserved; events delivered >30s after `ts` are flagged `late`. Rules and device state respect device time, so an old reading never overwrites a newer one.           |
| **Out of order**                   | Flagged `out_of_order`; the worker sorts each claimed batch by `(device, ts, seq)`.                                                                                           |
| **Disconnect / reconnect**         | Device keeps generating into its buffer, then replays oldest-first in batches. First authenticated contact flips it `online` and auto-resolves "stopped reporting" incidents. |
| **Bursts**                         | Batching; above a queue high-watermark the API returns `429 Retry-After: 2` and the device keeps buffering.                                                                   |
| **Malformed**                      | Rejected per event with reasons; rest of batch accepted; saved for debugging.                                                                                                 |
| **Clock skew**                     | `ts` >5 min in the future (or older than 7 days) is rejected. Silence is measured on the server clock.                                                                        |

## Live updates to dashboards

`GET /api/stream` (SSE). Every frame carries `id:` (durable change id). On reconnect, `EventSource` sends `Last-Event-ID` and the server replays the gap. The first frame is `hello {mode: fresh|resumed|reset, replayed}`; `reset` means the gap exceeded retention and the client must reload its snapshot.
