import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_MAX, sortBots, filterBots, attentionBots, truncateStep, kpiCounts, usageTile,
} from '../../web/ui/board.js';

const bots = [
  { id: 'idle', name: 'Idle', effective_status: 'idle', step: 'rest' },
  { id: 'work', name: 'Work', effective_status: 'working', step: 'scan' },
  { id: 'done', name: 'Done', effective_status: 'done', step: 'sent' },
  { id: 'err', name: 'Err', effective_status: 'error', step: '429' },
  { id: 'wait', name: 'Wait', status: 'waiting_user', step: 'need you' },
  { id: 'stuck', name: 'Stuck', effective_status: 'stuck', step: 'quiet' },
];

test('default sort is error, stuck, waiting_user, working, done, idle', () => {
  assert.deepEqual(sortBots(bots).map((b) => b.id), ['err', 'stuck', 'wait', 'work', 'done', 'idle']);
});

test('filters keep one status and all keeps the attention order', () => {
  assert.deepEqual(filterBots(sortBots(bots), 'waiting_user').map((b) => b.id), ['wait']);
  assert.deepEqual(filterBots(sortBots(bots), 'error').map((b) => b.id), ['err']);
  assert.deepEqual(filterBots(sortBots(bots), 'idle').map((b) => b.id), ['idle']);
  assert.equal(filterBots(sortBots(bots), 'all').length, bots.length);
});

test('attention row is error, stuck and waiting_user, ahead of idle', () => {
  const attn = attentionBots(bots);
  assert.deepEqual(attn.map((b) => b.id), ['err', 'stuck', 'wait']);
  assert.ok(!attn.some((b) => b.effective_status === 'idle'));
});

test('step display stays within the 80 character contract and drops control chars', () => {
  assert.equal(truncateStep('a'.repeat(STEP_MAX)).length, STEP_MAX);
  const long = truncateStep('a'.repeat(STEP_MAX + 20));
  assert.equal(long.length, STEP_MAX);
  assert.ok(long.endsWith('…'));
  assert.equal(truncateStep('ok\nline\tmore'), 'ok line more');
  assert.equal(truncateStep(null), '');
  assert.equal(truncateStep({ secret: true }), '');
});

test('kpi counts read summary fields and usage tile only when the feed exposes a number', () => {
  const counts = kpiCounts({
    summary: { working: 6, waiting_user: 2, error: 1, idle: 4, done: 1, stuck: 1, total: 15 },
  });
  assert.equal(counts.working, 6);
  assert.equal(counts.waiting_user, 2);
  assert.equal(counts.error, 1);
  assert.equal(usageTile(null), null);
  assert.equal(usageTile({ period: 'week', total_used_pct: null }), null);
  assert.deepEqual(usageTile({ period: 'week', total_used_pct: 37 }), { label: '本週額度', pct: 37 });
});
