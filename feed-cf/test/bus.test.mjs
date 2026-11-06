// Local free-plan bus: D1 via wrangler's platform proxy (no remote account, no deploy).
//   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';
import { SCHEMA } from '../src/schema.js';
import { connectFeed } from '../../web/feed.js';
import { botIdFor } from '../../web/lib/state.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'local-test-token';
const memory = new Map();

function installBrowserStubs() {
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => { memory.set(key, String(value)); },
    removeItem: (key) => { memory.delete(key); },
  };
  const nav = { userAgent: 'node-test', sendBeacon: () => true };
  try { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); } catch { /* Node's navigator is fixed; the beacon still no-ops */ }
}

test('grokbot-feed-cf on D1, free plan, no Durable Objects', { timeout: 60_000, concurrency: false }, async (t) => {
  const wranglerText = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  assert.equal(readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8').trim(), SCHEMA.trim());
  assert.match(wranglerText, /"name": "grokbot-feed-cf"/);
  assert.doesNotMatch(wranglerText, /durable_objects/);
  assert.doesNotMatch(wranglerText, /ratelimits/);
  assert.doesNotMatch(wranglerText, /custom_domain/);
  assert.doesNotMatch(wranglerText, /"routes"/);
  assert.match(wranglerText, /00000000-0000-0000-0000-000000000000/);

  const persist = mkdtempSync(path.join(tmpdir(), 'feed-cf-'));
  writeFileSync(path.join(root, '.dev.vars'), `PUBLISH_TOKEN=${TOKEN}\n`);
  const proxy = await getPlatformProxy({
    configPath: path.join(root, 'wrangler.jsonc'),
    remoteBindings: false,
    persist: { path: persist },
  });
  const env = proxy.env;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
      const response = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, init), env, proxy.ctx);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key === 'content-length') return;
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err?.message || err));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const topic = 'gbw-evidence01';

  t.after(async () => {
    server.close();
    await proxy.dispose();
    rmSync(path.join(root, '.dev.vars'), { force: true });
    rmSync(persist, { recursive: true, force: true });
  });

  const get = async (pathname) => {
    const res = await fetch(`${base}${pathname}`);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* sse or empty */ }
    return { res, text, data };
  };
  const publish = (room, line, token = TOKEN) => fetch(`${base}/publish/${room}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: line,
  });

  await t.test('health names the free D1 bus', async () => {
    const { res, data } = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(data.healthy, true);
    assert.equal(data.worker, 'grokbot-feed-cf');
    assert.equal(data.plan, 'workers-free');
    assert.equal(data.storage, 'd1');
    assert.equal(data.durable_objects, false);
    assert.equal(data.behavior_over_quota, 'reject');
    assert.equal(data.limits.worker_requests_per_day, 100000);
    assert.equal(data.limits.d1_rows_written_per_day, 100000);
    assert.equal(data.budget.limit, 2000);
  });

  await t.test('publish requires the token and keeps the JSON body', async () => {
    const room = 'gbw-authcheck1';
    const denied = await publish(room, '{"bot":"Nope","status":"idle","step":"no"}', 'wrong-token');
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).behavior, 'reject');
    const empty = await get(`/snapshot?topic=${room}`);
    assert.equal(empty.data.bots.length, 0);

    const line = '{"bot":"CF Writer","status":"working","step":"免費匯流排測試"}';
    const { stdout: curled } = await execFileAsync('curl', ['-sS', '--max-time', '10', '-D', '-', '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Content-Type: application/json', '-d', line, `${base}/publish/${topic}`], { encoding: 'utf8' });
    assert.match(curled, /HTTP\/1\.1 200/);
    assert.match(curled, /access-control-allow-origin: \*/i);
    const posted = JSON.parse(curled.slice(curled.indexOf('{')));
    assert.equal(posted.event, 'message');
    assert.equal(posted.message, line);
    assert.equal(posted.topic, topic);

    const usage = '{"type":"usage","total_used_pct":37,"resets_at":"2026-11-08T00:00:00+08:00","bots":{"CF Writer":4.1}}';
    const routines = '{"routines":{"bot":"CF Writer","items":[{"name":"Morning","schedule":"daily 09:00","next_run":"2026-11-07T09:00:00+08:00"}]}}';
    const roster = '{"roster":["CF Writer","Quiet Bot"]}';
    const extended = '{"bot":"CF Writer","status":"working","step":"仍保留舊欄位","type":"status","peer":"Quiet Bot","summary":"短句","ts":"2026-11-06T05:00:00+08:00"}';
    for (const body of [roster, usage, routines, extended]) {
      const res = await publish(topic, body);
      assert.equal(res.status, 200, body);
    }

    const snap = await get(`/snapshot?topic=${topic}`);
    assert.equal(snap.res.status, 200);
    const bot = snap.data.bots.find((row) => row.bot === 'CF Writer');
    assert.ok(bot, 'snapshot has the bot');
    assert.equal(bot.status, 'working');
    assert.equal(bot.message, extended);
    assert.equal(bot.type, 'status');
    assert.equal(bot.peer, 'Quiet Bot');
    assert.equal(bot.summary, '短句');
    assert.equal(bot.ts, '2026-11-06T05:00:00+08:00');
    assert.equal(snap.data.meta.usage.message, usage);
    assert.equal(snap.data.meta.roster.message, roster);
    assert.equal(snap.data.meta.routines.length, 1);

    const ev = await get(`/events?topic=${topic}&since=0`);
    assert.equal(ev.data.events.length, 5);
    assert.equal(ev.data.events[0].message, line);
    assert.equal(ev.data.events.at(-1).message, extended);
    assert.equal(ev.data.more, false);

    const sseRes = await fetch(`${base}/events?topic=${topic}&since=0&stream=sse`, { headers: { Accept: 'text/event-stream' } });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
    const sse = await sseRes.text();
    assert.match(sse, /retry: 15000/);
    assert.match(sse, /免費匯流排測試/);
    const evidenceDir = path.join(root, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, 'health.json'), JSON.stringify((await get('/health')).data, null, 2));
    writeFileSync(path.join(evidenceDir, 'publish.json'), JSON.stringify(posted, null, 2));
    writeFileSync(path.join(evidenceDir, 'snapshot.json'), JSON.stringify(snap.data, null, 2));
    writeFileSync(path.join(evidenceDir, 'events.sse'), sse);
  });

  await t.test('the office reducer shows the bot with no ntfy mailbox', async () => {
    installBrowserStubs();
    memory.clear();
    let state = null;
    const stop = await connectFeed({ topic, servers: [], cf: { base, topic, pollMs: 15000 } }, (next) => { state = next; });
    stop?.();
    const id = botIdFor('CF Writer');
    assert.ok(state?.bots[id], 'office state has CF Writer');
    assert.equal(state.bots[id].status, 'working');
    assert.equal(state.bots[id].name, 'CF Writer');
    assert.ok(state.bots[botIdFor('Quiet Bot')], 'roster bot is present');
    assert.equal(state.usage?.total_used_pct, 37);
    assert.ok(state.routines?.some((row) => row.routine === 'Morning'));
  });

  await t.test('rejects a bad topic, a long string, and a body over 4 KB', async () => {
    assert.equal((await publish('nope', '{"bot":"A","status":"idle"}')).status, 400);
    const chatty = JSON.stringify({ bot: 'CF Writer', status: 'idle', step: 'x'.repeat(501) });
    assert.equal((await publish(topic, chatty)).status, 400);
    const huge = JSON.stringify({ bot: 'CF Writer', status: 'idle', step: 'x'.repeat(5000) });
    assert.equal((await publish(topic, huge)).status, 413);
  });

  await t.test('caps retained lines and rejects once the daily publish budget is spent', async () => {
    env.KEEP_LINES = '2';
    const room = 'gbw-keeplines1';
    for (let i = 0; i < 5; i++) {
      const res = await publish(room, JSON.stringify({ bot: 'CF Writer', status: 'working', step: `n${i}` }));
      assert.equal(res.status, 200, `keep ${i}`);
    }
    const ev = await get(`/events?topic=${room}&since=0`);
    assert.ok(ev.data.events.length <= 2, `kept ${ev.data.events.length}`);
    env.KEEP_LINES = '600';

    const before = await get('/health');
    env.DAILY_PUBLISH_BUDGET = String(before.data.budget.used);
    const rejected = await publish('gbw-overbudget', '{"bot":"CF Writer","status":"idle","step":"over"}');
    const body = await rejected.json();
    assert.equal(rejected.status, 429);
    assert.equal(body.behavior, 'reject');
    assert.equal(body.error, 'budget');
    env.DAILY_PUBLISH_BUDGET = '2000';
    const after = await get(`/events?topic=gbw-overbudget&since=0`);
    assert.equal(after.data.events.length, 0);
  });
});
