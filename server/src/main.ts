/**
 * Process entrypoint. One codebase, three roles:
 *   api     HTTP ingestion + operator API + live stream (stateless, scale horizontally)
 *   worker  event processor + scanner + notification dispatcher
 *   all     both in one process (handy for a quick look)
 */
import { createCtx } from './context.js';
import { ChangeHub, buildApp } from './app.js';
import { seed } from './seed.js';
import { heartbeat } from './settings.js';
import { Processor } from './worker.js';
import { Scanner } from './scanner.js';
import { Dispatcher } from './notify/dispatcher.js';

const role = (process.argv[2] ?? 'all') as 'api' | 'worker' | 'all';
const ctx = createCtx({ component: role });
const stoppers: (() => Promise<void> | void)[] = [];

seed(ctx);

async function startApi() {
  const hub = new ChangeHub(ctx);
  hub.start();
  const app = buildApp(ctx, hub);
  await app.listen({ port: ctx.config.port, host: ctx.config.host });
  const startedAt = ctx.now();
  const beat = setInterval(() => heartbeat(ctx, 'api', startedAt, { port: ctx.config.port, stream_clients: hub.clients.size }), 2000);
  heartbeat(ctx, 'api', startedAt, { port: ctx.config.port });
  ctx.log.info(`API listening on http://localhost:${ctx.config.port}${ctx.config.serveWeb ? ' (serving dashboard)' : ''}`);
  stoppers.push(async () => {
    clearInterval(beat);
    hub.stop();
    await app.close();
  });
}

/** Run `fn` repeatedly; sleep `idleMs` when it reports no work. Never dies on an exception. */
function loop(name: string, fn: () => Promise<number> | number, idleMs: number) {
  let running = true;
  let current: Promise<void> = Promise.resolve();
  const run = async () => {
    while (running) {
      let did = 0;
      try {
        did = await fn();
      } catch (err) {
        ctx.log.error({ err, loop: name }, 'loop iteration crashed; continuing');
      }
      if (!did) await new Promise((r) => setTimeout(r, idleMs));
    }
  };
  current = run();
  stoppers.push(async () => {
    running = false;
    await current; // let the in-flight batch finish -> graceful shutdown, no half-processed work
  });
}

function startWorker() {
  const startedAt = ctx.now();
  const processor = new Processor(ctx);
  const scanner = new Scanner(ctx);
  const dispatcher = new Dispatcher(ctx);

  loop('processor', () => processor.tick(), ctx.config.worker.pollMs);
  loop('scanner', () => (scanner.run(), 0), ctx.config.scanner.intervalMs);
  loop('dispatcher', () => dispatcher.tick(), ctx.config.notifier.pollMs);
  const prune = setInterval(() => scanner.prune(), 60_000);

  const beat = setInterval(() => {
    heartbeat(ctx, 'worker', startedAt, { owner: processor.owner, processed: processor.processedTotal, failed: processor.failedTotal });
    heartbeat(ctx, 'scanner', startedAt, { last_run_at: scanner.lastRunAt });
    heartbeat(ctx, 'notifier', startedAt, {
      breaker: dispatcher.breaker.state,
      consecutive_failures: dispatcher.breaker.failures,
      sent: dispatcher.sentTotal,
      failed: dispatcher.failedTotal,
      last_error: dispatcher.lastError,
    });
  }, 2000);
  stoppers.push(() => {
    clearInterval(beat);
    clearInterval(prune);
  });
  ctx.log.info({ owner: processor.owner }, 'worker started (processor, scanner, notification dispatcher)');
}

async function shutdown(signal: string) {
  ctx.log.info({ signal }, 'shutting down gracefully');
  const force = setTimeout(() => process.exit(1), 10_000);
  for (const stop of stoppers.reverse()) await stop();
  ctx.db.close();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (role === 'api' || role === 'all') await startApi();
if (role === 'worker' || role === 'all') startWorker();
