// Optional event fields on the same ntfy JSON the bots already post.
// Old lines stay valid: {"bot","status","step"}. Extra keys are optional:
//   type: wake | status | step | send | recv | done | error
//   peer, summary (<=120), ts (ISO). Unknown keys are ignored.
// A line that carries status or step still updates the board. send/recv without
// status does not invent a status. Nothing here reads secrets or topic names.

import { cleanStr, parseTime } from './util.js';

export const EVENT_TYPES = ['wake', 'status', 'step', 'send', 'recv', 'done', 'error'];
export const SUMMARY_MAX = 120;
export const STEP_EVENT_MAX = 80;
export const TIMELINE_LIMIT = 50;
export const EVENT_KEEP = 200;

const EVENT_SET = new Set(EVENT_TYPES);
const CLASSIC = new Set(['activity', 'event']);

function clip(v, max) {
  const s = cleanStr(v, max);
  return s || '';
}

function inferType(rec) {
  const status = typeof rec.status === 'string' ? rec.status.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (status === 'error' || status === 'failed' || status === 'fail' || status === 'failure' || status === 'errored') return 'error';
  if (status === 'done' || status === 'finished' || status === 'complete' || status === 'completed' || status === 'success' || status === 'succeeded') return 'done';
  if (clip(rec.step, STEP_EVENT_MAX)) return 'step';
  if (status) return 'status';
  return null;
}

/**
 * One timeline row, or null when the record is not an event (usage, roster, looks, junk).
 * @param {object} rec
 * @param {number} [nowMs] clock used when ts/t are missing or far ahead
 */
export function normalizeEvent(rec, nowMs = Date.now()) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (rec.listed === true) return null;
  if (rec.roster || rec.looks || rec.groups || rec.chat || rec.routines || rec.check) return null;
  const rawType = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
  if (rawType === 'usage' || rawType === 'schedule') return null;
  const bot = clip(rec.bot, 80);
  if (!bot) return null;
  let type = EVENT_SET.has(rawType) ? rawType : null;
  if (!type) {
    if (rawType && !CLASSIC.has(rawType)) return null;
    type = inferType(rec);
  }
  if (!type) return null;
  let ms = parseTime(rec.ts);
  if (ms === null) ms = parseTime(rec.t);
  if (ms === null || ms > nowMs + 60e3) ms = nowMs;
  const step = clip(rec.step, STEP_EVENT_MAX);
  const peer = clip(rec.peer, 80);
  let summary = clip(rec.summary, SUMMARY_MAX);
  if (!summary && step) summary = clip(step, SUMMARY_MAX);
  const out = { ts: new Date(ms).toISOString(), ms, bot, type };
  if (step) out.step = step;
  if (peer) out.peer = peer;
  if (summary) out.summary = summary;
  return out;
}

/** Newest first. Comment lines and broken JSON are dropped. */
export function parseEventJsonl(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    const ev = normalizeEvent(rec);
    if (ev) out.push(ev);
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

function matchesBot(e, bot, name, includePeer) {
  if (!bot || bot === 'all') return true;
  if (e.id && e.id === bot) return true;
  if (e.bot === bot || (name && e.bot === name)) return true;
  if (includePeer && (e.peer === bot || (name && e.peer === name))) return true;
  return false;
}

/** Recent events for one bot or every bot. Default 50. Does not invent rows. */
export function selectTimeline(events, { bot = 'all', name = '', limit = TIMELINE_LIMIT } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TIMELINE_LIMIT;
  const list = (Array.isArray(events) ? events : []).filter((e) => e && matchesBot(e, bot, name, false));
  list.sort((a, b) => (Date.parse(b.ts) || b.ms || 0) - (Date.parse(a.ts) || a.ms || 0));
  return list.slice(0, lim);
}

/** send/recv rows that name a peer. No peer means no comms row. */
export function selectComms(events, { bot = 'all', name = '', limit = TIMELINE_LIMIT } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TIMELINE_LIMIT;
  const list = (Array.isArray(events) ? events : []).filter((e) =>
    e && (e.type === 'send' || e.type === 'recv') && e.peer && matchesBot(e, bot, name, true));
  list.sort((a, b) => (Date.parse(b.ts) || b.ms || 0) - (Date.parse(a.ts) || a.ms || 0));
  return list.slice(0, lim);
}

/** Directed pairs that actually appear. recv is drawn from peer to bot. */
export function commsEdges(entries) {
  const seen = new Set();
  const edges = [];
  for (const e of entries || []) {
    if (!e || !e.peer) continue;
    const from = e.type === 'recv' ? e.peer : e.bot;
    const to = e.type === 'recv' ? e.bot : e.peer;
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges;
}
