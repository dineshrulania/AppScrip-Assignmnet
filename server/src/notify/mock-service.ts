/**
 * Stand-in for an external notification provider (email/SMS/Slack/PagerDuty).
 * Runs as its own process so you can literally kill it to watch the platform cope.
 *
 *   POST /notify          deliver (honours Idempotency-Key: duplicates are acknowledged, not re-sent)
 *   GET  /inbox           what operators "received"
 *   POST /admin/mode      {"mode": "up" | "down" | "flaky" | "slow"}
 */
import http from 'node:http';

const port = Number(process.env.NOTIFIER_PORT ?? 4200);
let mode: 'up' | 'down' | 'flaky' | 'slow' = 'up';
const seen = new Set<string>();
const inbox: { at: string; key: string; payload: any }[] = [];

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/health') return send(res, mode === 'down' ? 503 : 200, { mode });
    if (req.method === 'GET' && url.pathname === '/inbox') return send(res, 200, { mode, delivered: inbox.length, inbox: inbox.slice(-100).reverse() });
    if (req.method === 'POST' && url.pathname === '/admin/mode') {
      const next = JSON.parse(raw || '{}').mode;
      if (!['up', 'down', 'flaky', 'slow'].includes(next)) return send(res, 400, { error: 'mode must be up|down|flaky|slow' });
      mode = next;
      console.log(`[notifier-mock] mode -> ${mode}`);
      return send(res, 200, { mode });
    }
    if (req.method === 'POST' && url.pathname === '/notify') {
      if (mode === 'down') return send(res, 503, { error: 'service unavailable (simulated outage)' });
      if (mode === 'flaky' && Math.random() < 0.5) return send(res, 502, { error: 'bad gateway (simulated flakiness)' });
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 5000));
      const key = String(req.headers['idempotency-key'] ?? '');
      if (key && seen.has(key)) return send(res, 200, { status: 'duplicate_ignored' });
      if (key) seen.add(key);
      const payload = JSON.parse(raw || '{}');
      inbox.push({ at: new Date().toISOString(), key, payload });
      console.log(`[notifier-mock] -> ${payload?.to?.name ?? '?'}: ${payload?.subject ?? ''}`);
      return send(res, 202, { status: 'queued' });
    }
    send(res, 404, { error: 'not found' });
  })
  .listen(port, () => console.log(`[notifier-mock] listening on :${port} (mode=${mode})`));
