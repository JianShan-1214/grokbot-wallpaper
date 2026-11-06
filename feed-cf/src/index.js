// Office status bus on Workers Free + D1.
// Durable Objects are on the free plan (SQLite backend) but this Worker does not use them: the live
// relay already spends that account's daily DO requests, and a status board can poll. KV free allows
// 1,000 writes a day, which is smaller than the ntfy quota this bus replaces. D1 free allows
// 100,000 rows written a day. SSE here is one short response (then the client waits and reconnects);
// a held stream would sit on the free plan's 10 ms of CPU.
//
// POST /publish/<topic>     body = one JSON line, same shape the bots already post to ntfy
// GET  /snapshot?topic=     latest status per bot, plus the latest roster/looks/usage/routines lines
// GET  /events?topic=&since=  lines after a cursor. Add stream=sse (or Accept: text/event-stream)
//                           for one SSE batch and `retry:` so EventSource reconnects.
import { SCHEMA } from './schema.js';

// Binding names live in worker-configuration.d.ts (`npm run types`). Do not hand-write Env.

const TOPIC = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_BYTES = 4096;
const MAX_STRING = 500;
const PAGE = 600;

let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    const statements = SCHEMA.split(';').map((sql) => sql.trim()).filter(Boolean);
    schemaReady = (async () => {
      for (const sql of statements) await env.DB.prepare(sql).run();
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function num(env, key, fallback) {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function isMap(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function longestString(v, depth = 0) {
  if (depth > 8 || v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (typeof v !== 'object') return 0;
  let max = 0;
  for (const item of Array.isArray(v) ? v : Object.values(v)) max = Math.max(max, longestString(item, depth + 1));
  return max;
}

function classify(rec) {
  if (Array.isArray(rec.roster)) return { kind: 'roster', slot: 'roster', bot: '' };
  if (isMap(rec.looks)) return { kind: 'looks', slot: 'looks', bot: '' };
  if (isMap(rec.groups)) return { kind: 'groups', slot: 'groups', bot: '' };
  if (isMap(rec.chat)) return { kind: 'chat', slot: 'chat', bot: '' };
  if (isMap(rec.check)) return { kind: 'check', slot: 'check', bot: '' };
  if (isMap(rec.routines)) {
    const name = typeof rec.routines.bot === 'string' ? rec.routines.bot.trim().slice(0, 80) : '';
    return { kind: 'routines', slot: name ? `routines:${name}` : 'routines', bot: name };
  }
  if (rec.type === 'usage' || (rec.total_used_pct != null && rec.bot == null && rec.status == null)) {
    return { kind: 'usage', slot: 'usage', bot: '' };
  }
  const name = typeof rec.bot === 'string' ? rec.bot.trim().slice(0, 80) : '';
  if (name && (rec.status != null || rec.step != null)) return { kind: 'status', slot: `bot:${name}`, bot: name };
  if (name) return { kind: 'event', slot: '', bot: name };
  return { kind: 'other', slot: '', bot: '' };
}

function presentedToken(request) {
  const header = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (bearer) return bearer[1];
  return (request.headers.get('x-publish-token') || '').trim();
}

async function tokenMatches(provided, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  // Workers have crypto.subtle.timingSafeEqual. Node's test runner does not, so the equal-length
  // hashes are compared byte by byte there. Both sides are SHA-256, so the length is not a secret.
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, X-Publish-Token, Accept',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
  };
}

function json(data, status = 200, extra = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra };
  return new Response(JSON.stringify(data), { status, headers });
}

function log(fields) {
  console.log(JSON.stringify({ service: 'grokbot-feed-cf', ...fields }));
}

function quotaError(err) {
  return /exceeded|quota|daily row/i.test(String(err?.message || err || ''));
}

function topicFrom(request, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const published = /^\/publish\/([^/]+)$/.exec(path);
  const raw = published ? decodeURIComponent(published[1]) : (url.searchParams.get('topic') || '');
  return TOPIC.test(raw) ? raw : '';
}

function sinceBound(raw, nowSec) {
  const s = String(raw ?? '').trim();
  if (!s || s === '0' || s === 'all' || s === 'latest') return { seq: 0, time: 0 };
  const rel = /^(\d+)(s|m|h)$/.exec(s);
  if (rel) {
    const mult = rel[2] === 'h' ? 3600 : rel[2] === 'm' ? 60 : 1;
    return { seq: 0, time: nowSec - Number(rel[1]) * mult };
  }
  if (/^\d{10,}$/.test(s)) return { seq: 0, time: Number(s) };
  if (/^\d+$/.test(s)) return { seq: Number(s), time: 0 };
  return { seq: 0, time: 0 };
}

function envelope(topic, row) {
  return {
    id: String(row.seq),
    time: Number(row.time) || 0,
    event: 'message',
    topic,
    message: row.body,
  };
}

function parsedFields(body) {
  let rec;
  try { rec = JSON.parse(body); } catch { return {}; }
  if (!isMap(rec)) return {};
  const out = {};
  if (typeof rec.bot === 'string') out.bot = rec.bot.slice(0, 80);
  if (typeof rec.status === 'string') out.status = rec.status.slice(0, 40);
  if (typeof rec.step === 'string') out.step = rec.step.slice(0, 160);
  if (typeof rec.type === 'string') out.type = rec.type.slice(0, 40);
  if (typeof rec.peer === 'string') out.peer = rec.peer.slice(0, 80);
  if (typeof rec.summary === 'string') out.summary = rec.summary.slice(0, 120);
  if (typeof rec.ts === 'string') out.ts = rec.ts.slice(0, 40);
  if (typeof rec.t === 'string') out.t = rec.t.slice(0, 40);
  return out;
}

async function readEvents(env, topic, since, nowSec) {
  const bound = sinceBound(since, nowSec);
  const rows = await env.DB.prepare(
    `SELECT seq, time, kind, bot, body FROM events
     WHERE topic = ? AND seq > ? AND time >= ?
     ORDER BY seq LIMIT ?`,
  ).bind(topic, bound.seq, bound.time, PAGE).all();
  const list = rows.results || [];
  let cursor = bound.seq;
  if (list.length) cursor = Number(list[list.length - 1].seq);
  else {
    const tip = await env.DB.prepare(
      'SELECT seq FROM events WHERE topic = ? ORDER BY seq DESC LIMIT 1',
    ).bind(topic).first();
    if (tip?.seq != null && Number(tip.seq) > cursor) cursor = Number(tip.seq);
  }
  return {
    cursor: String(cursor),
    more: list.length === PAGE,
    events: list.map((row) => envelope(topic, row)),
  };
}

async function readSnapshot(env, topic) {
  const rows = await env.DB.prepare(
    'SELECT slot, seq, time, body FROM snapshots WHERE topic = ?',
  ).bind(topic).all();
  const bots = [];
  const meta = { roster: null, looks: null, groups: null, chat: null, usage: null, check: null, routines: [] };
  let cursor = 0;
  for (const row of rows.results || []) {
    cursor = Math.max(cursor, Number(row.seq) || 0);
    const item = { seq: Number(row.seq), time: Number(row.time) || 0, message: row.body, ...parsedFields(row.body) };
    if (String(row.slot).startsWith('bot:')) bots.push(item);
    else if (String(row.slot).startsWith('routines:')) meta.routines.push(item);
    else if (Object.prototype.hasOwnProperty.call(meta, row.slot)) meta[row.slot] = item;
  }
  bots.sort((a, b) => String(a.bot).localeCompare(String(b.bot)));
  return { topic, cursor: String(cursor), as_of: Math.floor(Date.now() / 1000), bots, meta };
}

async function prune(env, topic, nowSec) {
  const retain = num(env, 'RETAIN_SECONDS', 43200);
  const keep = Math.max(1, num(env, 'KEEP_LINES', 600));
  const cutoff = nowSec - retain;
  await env.DB.prepare(
    `DELETE FROM events WHERE seq IN (
       SELECT seq FROM events WHERE topic = ? AND time < ? ORDER BY seq LIMIT 8
     )`,
  ).bind(topic, cutoff).run();
  await env.DB.prepare(
    `DELETE FROM events WHERE seq IN (
       SELECT seq FROM (
         SELECT seq FROM events WHERE topic = ? ORDER BY seq DESC LIMIT -1 OFFSET ?
       ) ORDER BY seq LIMIT 8
     )`,
  ).bind(topic, keep).run();
}

async function publish(request, env, url) {
  const expected = String(env.PUBLISH_TOKEN || '');
  if (!expected) return json({ error: 'unconfigured', behavior: 'reject' }, 503);
  const provided = presentedToken(request);
  if (!provided || !(await tokenMatches(provided, expected))) {
    log({ msg: 'publish_rejected', reason: 'unauthorized', behavior: 'reject' });
    return json({ error: 'unauthorized', behavior: 'reject' }, 401);
  }

  let topic = '';
  const pathTopic = topicFrom(request, url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/publish/')) {
    if (!pathTopic) return json({ error: 'bad_topic', behavior: 'reject' }, 400);
    topic = pathTopic;
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    return json({ error: 'too_large', behavior: 'reject', limit: MAX_BYTES }, 413);
  }
  let rec;
  try { rec = JSON.parse(text); } catch { return json({ error: 'bad_json', behavior: 'reject' }, 400); }
  if (!isMap(rec)) return json({ error: 'bad_json', behavior: 'reject' }, 400);
  if (longestString(rec) > MAX_STRING) {
    return json({ error: 'too_long', behavior: 'reject', limit: MAX_STRING }, 400);
  }
  if (!topic) {
    const fromBody = typeof rec.topic === 'string' ? rec.topic.trim() : '';
    const fromQuery = url.searchParams.get('topic') || '';
    topic = TOPIC.test(fromQuery) ? fromQuery : TOPIC.test(fromBody) ? fromBody : '';
  }
  if (!topic) return json({ error: 'bad_topic', behavior: 'reject' }, 400);

  const day = utcDay();
  const limit = Math.max(1, num(env, 'DAILY_PUBLISH_BUDGET', 2000));
  let used = 0;
  try {
    const row = await env.DB.prepare('SELECT publishes FROM budget WHERE day = ?').bind(day).first();
    used = Number(row?.publishes || 0);
  } catch (err) {
    if (quotaError(err)) return json({ error: 'quota', behavior: 'reject', reset: '00:00:00Z' }, 503);
    throw err;
  }
  if (used >= limit) {
    log({ msg: 'publish_rejected', reason: 'budget', behavior: 'reject', used, limit });
    return json({
      error: 'budget', behavior: 'reject', limit, used, reset: '00:00:00Z',
    }, 429, { 'retry-after': String(secondsUntilUtcMidnight()) });
  }

  const kindInfo = classify(rec);
  const time = Math.floor(Date.now() / 1000);
  try {
    const inserted = await env.DB.prepare(
      'INSERT INTO events (topic, time, kind, bot, body) VALUES (?, ?, ?, ?, ?) RETURNING seq',
    ).bind(topic, time, kindInfo.kind, kindInfo.bot, text).first();
    const seq = Number(inserted?.seq);
    if (!Number.isFinite(seq)) throw new Error('insert did not return seq');
    if (kindInfo.slot) {
      await env.DB.prepare(
        `INSERT INTO snapshots (topic, slot, seq, time, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(topic, slot) DO UPDATE SET seq = excluded.seq, time = excluded.time, body = excluded.body`,
      ).bind(topic, kindInfo.slot, seq, time, text).run();
    }
    await env.DB.prepare(
      `INSERT INTO budget (day, publishes) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET publishes = publishes + 1`,
    ).bind(day).run();
    try { await prune(env, topic, time); } catch (err) {
      log({ msg: 'prune_failed', error: String(err?.message || err).slice(0, 200) });
    }
    log({ msg: 'publish', kind: kindInfo.kind, seq, status: 200 });
    return json({ ok: true, id: String(seq), time, topic, event: 'message', message: text });
  } catch (err) {
    if (quotaError(err)) {
      log({ msg: 'publish_rejected', reason: 'quota', behavior: 'reject' });
      return json({ error: 'quota', behavior: 'reject', reset: '00:00:00Z' }, 503);
    }
    log({ msg: 'publish_failed', error: String(err?.message || err).slice(0, 200) });
    return json({ error: 'storage', behavior: 'reject' }, 500);
  }
}

function wantsSse(request, url) {
  if (url.searchParams.get('stream') === 'sse') return true;
  return (request.headers.get('accept') || '').includes('text/event-stream');
}

function sseResponse(page, pollSeconds) {
  const retry = Math.max(1, pollSeconds) * 1000;
  let body = `retry: ${retry}\n\n`;
  for (const ev of page.events) {
    body += `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
  }
  if (!page.events.length) body += `: idle ${page.cursor}\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'x-cursor': page.cursor,
    },
  });
}

async function health(env) {
  const day = utcDay();
  let used = null;
  try {
    const row = await env.DB.prepare('SELECT publishes FROM budget WHERE day = ?').bind(day).first();
    used = Number(row?.publishes || 0);
  } catch (err) {
    if (!quotaError(err)) throw err;
    used = null;
  }
  return json({
    healthy: used !== null,
    worker: 'grokbot-feed-cf',
    plan: 'workers-free',
    storage: 'd1',
    durable_objects: false,
    behavior_over_quota: 'reject',
    budget: {
      limit: Math.max(1, num(env, 'DAILY_PUBLISH_BUDGET', 2000)),
      used,
      behavior: 'reject',
      reset: '00:00:00Z',
    },
    limits: {
      worker_requests_per_day: 100000,
      cpu_ms: 10,
      d1_rows_read_per_day: 5000000,
      d1_rows_written_per_day: 100000,
      d1_storage_gb: 5,
      message_bytes: MAX_BYTES,
      string_chars: MAX_STRING,
      retain_seconds: num(env, 'RETAIN_SECONDS', 43200),
      keep_lines: num(env, 'KEEP_LINES', 600),
      poll_seconds: num(env, 'POLL_SECONDS', 15),
    },
  });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

  if (path === '/' && request.method === 'GET') {
    return json({
      worker: 'grokbot-feed-cf',
      plan: 'workers-free',
      endpoints: ['/health', '/publish/<topic>', '/snapshot?topic=', '/events?topic=&since='],
    });
  }
  if (path === '/health' && request.method === 'GET') return health(env);

  if ((path === '/snapshot' || path === '/events') && request.method === 'GET') {
    const topic = topicFrom(request, url);
    if (!topic) return json({ error: 'bad_topic', behavior: 'reject' }, 400);
    try {
      if (path === '/snapshot') return json(await readSnapshot(env, topic));
      const nowSec = Math.floor(Date.now() / 1000);
      const page = await readEvents(env, topic, url.searchParams.get('since'), nowSec);
      const poll = num(env, 'POLL_SECONDS', 15);
      if (wantsSse(request, url)) return sseResponse(page, poll);
      return json({ topic, cursor: page.cursor, more: page.more, retry_ms: poll * 1000, events: page.events });
    } catch (err) {
      if (quotaError(err)) return json({ error: 'quota', behavior: 'reject', reset: '00:00:00Z' }, 503);
      log({ msg: 'read_failed', error: String(err?.message || err).slice(0, 200) });
      return json({ error: 'storage', behavior: 'reject' }, 500);
    }
  }

  if ((path === '/publish' || path.startsWith('/publish/')) && request.method === 'POST') {
    return publish(request, env, url);
  }
  if (request.method === 'POST' || request.method === 'GET') return json({ error: 'not_found', behavior: 'reject' }, 404);
  return json({ error: 'method', behavior: 'reject' }, 405);
}

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
      return await handle(request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      log({ msg: 'unhandled', error: message.slice(0, 200) });
      if (quotaError(err)) return json({ error: 'quota', behavior: 'reject', reset: '00:00:00Z' }, 503);
      return json({ error: 'storage', behavior: 'reject' }, 500);
    }
  },
};
