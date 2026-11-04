import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StateStore } from '../state.js';
import { FEED_BASE } from '../../web/lib/feedbase.js';
import {
  SUMMARY_MAX, TIMELINE_LIMIT, normalizeEvent, parseEventJsonl, selectTimeline, selectComms, commsEdges,
} from '../../web/lib/events.js';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const T0 = Date.parse('2026-11-04T09:00:00+08:00');
function make() {
  let now = T0;
  const store = new StateStore({ now: () => now, tz: 'Asia/Taipei' });
  return {
    store,
    at: (ms) => { now = ms; },
    iso: (ms) => new Date(ms).toISOString(),
  };
}

test('old bot/status/step line still sets status and becomes a timeline row', () => {
  const { store, iso } = make();
  store.apply({ t: iso(T0), bot: 'X Writer', status: 'working', step: '在寫草稿' });
  store.apply({ t: iso(T0 + 1000), bot: 'X Writer', status: 'error', step: '429' });
  const st = store.snapshot();
  assert.equal(st.bots['x-writer'].status, 'error');
  assert.equal(st.bots['x-writer'].step, '429');
  assert.equal(st.events[0].type, 'error');
  assert.equal(st.events[0].bot, 'X Writer');
  assert.equal(st.events.at(-1).type, 'step');
});

test('optional type/peer/summary/ts keep the status update and do not drop unknown clients fields', () => {
  const { store, iso } = make();
  const t = iso(T0);
  store.apply({
    t, ts: t, bot: 'Banner & Visuals', status: 'working', step: '在畫封面',
    type: 'send', peer: 'X Writer', summary: '封面用這組標題', extra: 'ignored',
  });
  const st = store.snapshot();
  assert.equal(st.bots['banner-visuals'].effective_status, 'working');
  assert.equal(st.bots['banner-visuals'].step, '在畫封面');
  assert.equal(st.events.length, 1);
  assert.equal(st.events[0].type, 'send');
  assert.equal(st.events[0].peer, 'X Writer');
  assert.equal(st.events[0].summary, '封面用這組標題');
  assert.equal(st.feed[0].status, 'working');
});

test('send/recv without status does not invent a status or a bot', () => {
  const { store, iso } = make();
  store.apply({ t: iso(T0), bot: 'Finance Team', status: 'waiting_user', step: '等你確認' });
  store.apply({ t: iso(T0 + 5000), bot: 'Finance Team', type: 'send', peer: 'Analytics Analyst', summary: '先別用這週數字' });
  store.apply({ t: iso(T0 + 6000), bot: 'Nobody New', type: 'recv', peer: 'Finance Team', summary: '收到' });
  const st = store.snapshot();
  assert.equal(st.bots['finance-team'].status, 'waiting_user');
  assert.equal(st.bots['finance-team'].step, '等你確認');
  assert.equal(st.bots['nobody-new'], undefined);
  assert.deepEqual(st.events.slice(0, 2).map((e) => e.type), ['recv', 'send']);
});

test('roster listings and unknown types are not timeline events', () => {
  const { store, iso } = make();
  store.apply({ t: iso(T0), bot: 'Nova', status: 'idle', step: '', listed: true });
  store.apply({ type: 'something-else', bot: 'Nova', status: 'working', step: 'nope' });
  store.apply({ t: iso(T0), type: 'usage', total_used_pct: 3 });
  const st = store.snapshot();
  assert.equal(st.events.length, 0);
  assert.equal(st.bots.nova.status, 'idle');
  assert.ok(st.meta.skipped >= 1);
});

test('summary stays within 120 characters and control characters are dropped', () => {
  const ev = normalizeEvent({
    bot: 'A', status: 'working', step: 'x', type: 'step',
    summary: `密${'a'.repeat(200)}\nline`,
    ts: '2026-11-04T09:00:00+08:00',
  }, T0);
  assert.ok(ev.summary.length <= SUMMARY_MAX);
  assert.equal(ev.summary.includes('\n'), false);
  assert.equal(normalizeEvent({ type: 'usage', bot: 'A' }, T0), null);
  assert.equal(normalizeEvent({ bot: 'A', type: 'ping' }, T0), null);
});

test('timeline is the newest 50 and can focus one bot; comms only real send/recv', () => {
  const events = [];
  for (let i = 0; i < 80; i++) {
    events.push({
      ts: new Date(T0 + i * 1000).toISOString(), ms: T0 + i * 1000,
      bot: i % 2 ? 'X Writer' : 'Jevopus', id: i % 2 ? 'x-writer' : 'jevopus',
      type: 'step', summary: `n${i}`,
    });
  }
  events.push({
    ts: new Date(T0 + 90000).toISOString(), ms: T0 + 90000,
    bot: 'X Writer', id: 'x-writer', type: 'send', peer: 'Banner & Visuals', summary: '標題',
  });
  const all = selectTimeline(events);
  assert.equal(all.length, TIMELINE_LIMIT);
  assert.equal(all[0].type, 'send');
  const one = selectTimeline(events, { bot: 'x-writer', name: 'X Writer' });
  assert.ok(one.every((e) => e.bot === 'X Writer'));
  assert.equal(selectComms(events).length, 1);
  assert.deepEqual(commsEdges(selectComms(events)), [{ from: 'X Writer', to: 'Banner & Visuals' }]);
  assert.deepEqual(selectComms([]), []);
  assert.deepEqual(commsEdges([]), []);
  assert.deepEqual(commsEdges(selectTimeline(events.filter((e) => e.type === 'step'))), []);
});

test('recv is drawn from the peer, and a missing peer is not a link', () => {
  const rows = [
    { ts: '2026-11-04T09:13:00+08:00', bot: 'Banner & Visuals', type: 'recv', peer: 'X Writer', summary: '收到' },
    { ts: '2026-11-04T09:14:00+08:00', bot: 'Banner & Visuals', type: 'send', summary: '沒有對象' },
  ];
  assert.equal(selectComms(rows).length, 1);
  assert.deepEqual(commsEdges(selectComms(rows)), [{ from: 'X Writer', to: 'Banner & Visuals' }]);
});

test('DEMO jsonl is labeled, covers wake/status/step/send/recv, and keeps bot/status/step', () => {
  const raw = read('web/data/demo-events.jsonl');
  assert.match(raw.split('\n')[0], /^# DEMO/);
  const events = parseEventJsonl(raw);
  const types = new Set(events.map((e) => e.type));
  for (const t of ['wake', 'status', 'step', 'send', 'recv', 'done', 'error']) assert.ok(types.has(t), t);
  assert.ok(selectComms(events).length >= 2);
  assert.ok(commsEdges(selectComms(events)).length >= 1);
  const warren = selectComms(events, { bot: 'warren-buffett', name: 'Warren Buffett' });
  assert.equal(warren.length, 0);
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    const rec = JSON.parse(s);
    if (!rec.bot) continue;
    assert.equal(typeof rec.status, 'string');
    assert.equal(typeof rec.step, 'string');
    if (rec.summary) assert.ok(rec.summary.length <= SUMMARY_MAX);
  }
  const legacy = events.find((e) => e.summary && e.summary.startsWith('舊格式'));
  assert.equal(legacy.type, 'step');
  assert.equal(legacy.bot, 'Grok Bot');
});

test('feed, relay, hash topic, face and wallpaper contracts stay in place', () => {
  assert.equal(FEED_BASE, 'https://ntfy.sh/');
  const feed = read('web/feed.js');
  assert.match(feed, /const RELAY = 'https:\/\/relay\.0xcodila\.com'/);
  assert.match(feed, /feedFromHash/);
  const face = read('web/face/face.js');
  assert.match(face, /const FEED_BASE = 'https:\/\/ntfy\.sh\/'/);
  assert.match(face, /b\.status = b\.effective_status = WORDS\[word\]/);
  assert.match(read('web/face/index.html'), /<html/);
  const app = read('web/app.js');
  assert.match(app, /params\.get\('mode'\) === 'wallpaper'/);
  assert.match(app, /wallpaper\.js/);
  assert.match(app, /demo-events\.jsonl/);
  assert.match(read('web/index.html'), /mode=wallpaper/);
  assert.match(read('landing/assemble.mjs'), /demo-events/);
  assert.match(read('web/lib/feedbase.js'), /#\(\[A-Za-z0-9_-\]\{6,64\}\)/);
});
