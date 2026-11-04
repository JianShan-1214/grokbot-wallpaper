/*
 * Style B — dark ops board for /office/. One bot per cell or row. Reads the same state the 3D office used
 * (bots, summary, usage, floors). Does not parse the hash, open a mailbox, or rename status JSON fields.
 *
 *   initUI({ onSelectBot })
 *   renderUI(state, { selectedBot })
 *
 * Visible text is Traditional Chinese. Every value goes in through textContent. step is clipped to 80 characters.
 */

export const STEP_MAX = 80;

export const STATUS_LABEL = {
  working: '工作中',
  idle: '休息',
  waiting_user: '等你',
  error: '錯誤',
  stuck: '卡住',
  done: '完成',
};

/** Attention order, then the rest. stuck sits with the statuses that need a person, ahead of idle. */
export const STATUS_RANK = {
  error: 0,
  stuck: 1,
  waiting_user: 2,
  working: 3,
  done: 4,
  idle: 5,
};

const ATTENTION = new Set(['error', 'waiting_user', 'stuck']);
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'working', label: '工作中' },
  { id: 'waiting_user', label: '等你' },
  { id: 'error', label: '錯誤' },
  { id: 'idle', label: '休息' },
  { id: 'done', label: '完成' },
];
const KPIS = [
  { key: 'working', label: '工作中', status: 'working' },
  { key: 'waiting_user', label: '等你', status: 'waiting_user' },
  { key: 'error', label: '錯誤', status: 'error' },
];

const LS_FILTER = 'ops.board.filter';
const LS_VIEW = 'ops.board.view';

let U = null;

export function effStatus(bot) {
  const s = bot && (bot.effective_status || bot.status);
  return typeof s === 'string' && STATUS_RANK[s] != null ? s : 'idle';
}

export function truncateStep(step) {
  if (step == null || (typeof step !== 'string' && typeof step !== 'number')) return '';
  const s = String(step).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= STEP_MAX) return s;
  return s.slice(0, STEP_MAX - 1).trimEnd() + '…';
}

export function sortBots(list) {
  return [...list].sort((a, b) => {
    const d = (STATUS_RANK[effStatus(a)] ?? 9) - (STATUS_RANK[effStatus(b)] ?? 9);
    if (d) return d;
    const ta = Date.parse(a.last_event || '') || 0;
    const tb = Date.parse(b.last_event || '') || 0;
    if (ta !== tb) return tb - ta;
    return String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''), 'zh-Hant');
  });
}

export function filterBots(list, filter) {
  if (!filter || filter === 'all') return list;
  return list.filter((b) => effStatus(b) === filter);
}

export function attentionBots(list) {
  return sortBots(list.filter((b) => ATTENTION.has(effStatus(b))));
}

export function kpiCounts(state) {
  const blank = { working: 0, waiting_user: 0, error: 0, idle: 0, done: 0, stuck: 0, total: 0 };
  const s = state && state.summary;
  if (s && typeof s === 'object') {
    for (const k of Object.keys(blank)) blank[k] = num(s[k]);
    if (!s.total && s.total !== 0) {
      blank.total = blank.working + blank.waiting_user + blank.error + blank.idle + blank.done + blank.stuck;
    }
    return blank;
  }
  for (const bot of Object.values((state && state.bots) || {})) {
    const st = effStatus(bot);
    blank[st] = (blank[st] || 0) + 1;
    blank.total++;
  }
  return blank;
}

export function usageTile(usage) {
  if (!usage || usage.total_used_pct == null || usage.total_used_pct === '') return null;
  const n = typeof usage.total_used_pct === 'number' ? usage.total_used_pct : Number(usage.total_used_pct);
  if (!Number.isFinite(n)) return null;
  const label = usage.period === 'day' ? '今日額度' : usage.period === 'month' ? '本月額度' : '本週額度';
  return { label, pct: Math.round(n * 10) / 10 };
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function lsGet(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* private mode */ }
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'hidden') n.hidden = true;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

function setText(n, v) {
  const s = v == null ? '' : String(v);
  if (n && n.textContent !== s) n.textContent = s;
}

function setAttr(n, k, v) {
  if (!n) return;
  const s = v == null ? '' : String(v);
  if (n.getAttribute(k) !== s) n.setAttribute(k, s);
}

function setHidden(n, hidden) {
  if (n && n.hidden !== hidden) n.hidden = hidden;
}

function rel(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return '剛剛';
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}時`;
  return `${Math.floor(h / 24)}天`;
}

function clock(iso) {
  const t = Date.parse(iso || '');
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function floorName(state, bot) {
  const group = bot.group && String(bot.group).trim();
  if (group) return truncateStep(group).slice(0, 40);
  const f = (state.floors || []).find((x) => x.id === bot.floor);
  return f && f.name ? truncateStep(f.name).slice(0, 40) : '';
}

function syncChildren(parent, items, make, paint) {
  const want = new Set(items.map((b) => b.id));
  for (const child of [...parent.children]) {
    if (!want.has(child.dataset.id)) child.remove();
  }
  const byId = new Map([...parent.children].map((c) => [c.dataset.id, c]));
  items.forEach((bot, i) => {
    let node = byId.get(bot.id);
    if (!node) {
      node = make(bot);
      byId.set(bot.id, node);
    }
    paint(node, bot);
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
  });
}

export function initUI(handlers) {
  if (U && U.timer) clearInterval(U.timer);
  U = {
    h: handlers || {},
    filter: FILTERS.some((f) => f.id === lsGet(LS_FILTER)) ? lsGet(LS_FILTER) : 'all',
    view: lsGet(LS_VIEW) === 'table' ? 'table' : 'grid',
    nodes: {},
  };

  const root = document.getElementById('ops') || document.body.appendChild(el('div', { id: 'ops' }));
  root.textContent = '';
  root.hidden = false;

  const liveDot = el('i', { class: 'ops-live-dot', 'aria-hidden': 'true' });
  const clockEl = el('time', { class: 'ops-clock ops-num', text: '--:--:--' });
  const demo = el('span', { class: 'ops-demo', text: '示範', hidden: true, title: '示範資料，不是即時頻道' });

  const kpis = el('div', { class: 'ops-kpis', role: 'group', 'aria-label': '狀態計數' });
  const kpi = {};
  for (const k of KPIS) {
    const count = el('b', { class: 'ops-num', text: '0' });
    const btn = el('button', {
      type: 'button', class: 'ops-kpi', 'data-s': k.status, 'data-k': k.key, 'aria-pressed': 'false',
    }, el('span', { class: 'ops-kpi-label', text: k.label }), count);
    btn.addEventListener('click', () => setFilter(U.filter === k.key ? 'all' : k.key));
    kpi[k.key] = { btn, count };
    kpis.append(btn);
  }
  const usageCount = el('b', { class: 'ops-num', text: '—' });
  const usageLabel = el('span', { class: 'ops-kpi-label', text: '本週額度' });
  const usage = el('div', { class: 'ops-kpi ops-kpi--usage', hidden: true }, usageLabel, usageCount);
  kpis.append(usage);

  const filters = el('div', { class: 'ops-filters', role: 'toolbar', 'aria-label': '篩選狀態' });
  const filterBtns = {};
  for (const f of FILTERS) {
    const count = el('b', { class: 'ops-num', text: '0' });
    const btn = el('button', { type: 'button', class: 'ops-filter', 'data-filter': f.id, 'aria-pressed': 'false' },
      el('span', { text: f.label }), count);
    btn.addEventListener('click', () => setFilter(f.id));
    filterBtns[f.id] = { btn, count };
    filters.append(btn);
  }

  const viewBtns = {};
  const viewBar = el('div', { class: 'ops-view', role: 'group', 'aria-label': '版面' });
  for (const [id, label] of [['grid', '格子'], ['table', '表格']]) {
    const btn = el('button', { type: 'button', class: 'ops-view-btn', 'data-view': id, 'aria-pressed': 'false', text: label });
    btn.addEventListener('click', () => setView(id));
    viewBtns[id] = btn;
    viewBar.append(btn);
  }

  const attnCount = el('b', { class: 'ops-num', text: '0' });
  const attnRow = el('div', { class: 'ops-attn-row' });
  const attnClear = el('p', { class: 'ops-attn-clear', text: '目前沒有錯誤、等你或卡住。', hidden: true });
  const attn = el('section', { class: 'ops-attn', 'aria-label': '需要注意' },
    el('header', { class: 'ops-attn-head' },
      el('span', { class: 'ops-kicker', text: '注意' }),
      attnCount,
      el('span', { class: 'ops-attn-note', text: '錯誤與等你排在整表之前' })),
    attnRow,
    attnClear);

  const grid = el('div', { class: 'ops-grid', role: 'list' });
  const tableBody = el('tbody');
  const table = el('table', { class: 'ops-table' },
    el('thead', null, el('tr', null,
      el('th', { text: '狀態', scope: 'col' }),
      el('th', { text: '機器人', scope: 'col' }),
      el('th', { text: '步驟', scope: 'col' }),
      el('th', { text: '群組', scope: 'col' }),
      el('th', { text: '更新', scope: 'col' }))),
    tableBody);
  const empty = el('p', { class: 'ops-empty', hidden: true });
  const main = el('section', { class: 'ops-main', 'aria-label': '全部機器人' }, grid, table, empty);

  const shown = el('span', { class: 'ops-shown ops-num' });

  root.append(
    el('header', { class: 'ops-top' },
      el('div', { class: 'ops-bar' },
        el('div', { class: 'ops-brand' },
          el('span', { class: 'ops-mark', text: 'OPS' }),
          el('div', { class: 'ops-brand-text' },
            el('strong', { text: 'Grok Bot' }),
            el('span', { class: 'ops-live' }, liveDot, el('span', { text: '即時' }), clockEl))),
        kpis,
        el('div', { class: 'ops-tools' }, demo, shown, viewBar)),
      filters),
    attn,
    main);

  U.nodes = {
    root, clock: clockEl, demo, kpi, usage, usageCount, usageLabel,
    filters: filterBtns, viewBtns, shown, attnCount, attnRow, attnClear, grid, table, tableBody, empty,
  };
  paintChrome();
  U.timer = setInterval(() => {
    if (document.hidden || !U.last) return;
    setText(U.nodes.clock, clock(U.last.now));
    stampTimes(U.last);
  }, 1000);
}

function setFilter(id) {
  if (!FILTERS.some((f) => f.id === id)) return;
  U.filter = id;
  lsSet(LS_FILTER, id);
  paintChrome();
  if (U.last) renderUI(U.last, U.lastView || {});
}

function setView(id) {
  U.view = id === 'table' ? 'table' : 'grid';
  lsSet(LS_VIEW, U.view);
  paintChrome();
  if (U.last) renderUI(U.last, U.lastView || {});
}

function paintChrome() {
  const n = U.nodes;
  for (const f of FILTERS) {
    const on = U.filter === f.id;
    setAttr(n.filters[f.id].btn, 'aria-pressed', on ? 'true' : 'false');
  }
  for (const [id, btn] of Object.entries(n.viewBtns)) setAttr(btn, 'aria-pressed', U.view === id ? 'true' : 'false');
  for (const k of KPIS) setAttr(n.kpi[k.key].btn, 'aria-pressed', U.filter === k.key ? 'true' : 'false');
  setHidden(n.grid, U.view !== 'grid');
  setHidden(n.table, U.view !== 'table');
}

function pick(id) {
  const cur = U.lastView && U.lastView.selectedBot;
  if (U.h.onSelectBot) U.h.onSelectBot(cur === id ? null : id);
}

function makeCell() {
  const chip = el('span', { class: 'ops-chip' });
  const name = el('b', { class: 'ops-name' });
  const meta = el('span', { class: 'ops-meta' });
  const step = el('span', { class: 'ops-step' });
  const ago = el('span', { class: 'ops-ago ops-num' });
  const btn = el('button', { type: 'button', class: 'ops-cell', role: 'listitem' },
    el('span', { class: 'ops-block', 'aria-hidden': 'true' }),
    el('span', { class: 'ops-cell-top' }, name, ago, chip),
    meta, step);
  btn.addEventListener('click', () => pick(btn.dataset.id));
  btn._f = { chip, name, meta, step, ago };
  return btn;
}

function makeAttn() {
  const chip = el('span', { class: 'ops-chip' });
  const name = el('b', { class: 'ops-name' });
  const step = el('span', { class: 'ops-step' });
  const ago = el('span', { class: 'ops-ago ops-num' });
  const btn = el('button', { type: 'button', class: 'ops-cell ops-cell--attn' },
    el('span', { class: 'ops-block', 'aria-hidden': 'true' }),
    el('span', { class: 'ops-cell-top' }, chip, name, ago),
    step);
  btn.addEventListener('click', () => pick(btn.dataset.id));
  btn._f = { chip, name, step, ago, meta: null };
  return btn;
}

function makeRow() {
  const chip = el('span', { class: 'ops-chip' });
  const name = el('b', { class: 'ops-name' });
  const step = el('td', { class: 'ops-step' });
  const meta = el('td', { class: 'ops-meta' });
  const ago = el('td', { class: 'ops-ago ops-num' });
  const tr = el('tr', { class: 'ops-row', tabindex: '0' },
    el('td', null, chip),
    el('td', null, name),
    step, meta, ago);
  const go = () => pick(tr.dataset.id);
  tr.addEventListener('click', go);
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  tr._f = { chip, name, step, meta, ago };
  return tr;
}

function paintBot(node, bot, state, selected) {
  const st = effStatus(bot);
  const step = truncateStep(bot.step);
  const where = floorName(state, bot);
  const when = rel(bot.last_event || bot.since);
  setAttr(node, 'data-id', bot.id);
  setAttr(node, 'data-s', st);
  node.classList.toggle('is-selected', selected === bot.id);
  if (node.tagName === 'BUTTON') setAttr(node, 'aria-pressed', selected === bot.id ? 'true' : 'false');
  else setAttr(node, 'aria-selected', selected === bot.id ? 'true' : 'false');
  const f = node._f;
  setText(f.chip, STATUS_LABEL[st] || st);
  setText(f.name, bot.name || bot.id || '');
  if (f.meta) setText(f.meta, where);
  setText(f.step, step || '沒有步驟');
  setText(f.ago, when);
  const label = `${bot.name || bot.id}，${STATUS_LABEL[st] || st}`;
  if (node.getAttribute('aria-label') !== label) setAttr(node, 'aria-label', label);
}

function stampTimes(state) {
  const bots = state.bots || {};
  const touch = (parent) => {
    for (const node of parent.children) {
      const bot = bots[node.dataset.id];
      if (bot && node._f) setText(node._f.ago, rel(bot.last_event || bot.since));
    }
  };
  touch(U.nodes.attnRow);
  touch(U.nodes.grid);
  touch(U.nodes.tableBody);
  setText(U.nodes.clock, clock(state.now));
}

export function renderUI(state, view) {
  if (!U || !state) return;
  U.last = state;
  U.lastView = view || {};
  const n = U.nodes;
  const counts = kpiCounts(state);
  const bots = sortBots(Object.values(state.bots || {}));
  const selected = view && view.selectedBot;

  for (const k of KPIS) {
    const v = counts[k.key] || 0;
    setText(n.kpi[k.key].count, String(v));
    n.kpi[k.key].btn.classList.toggle('is-zero', v === 0);
    n.kpi[k.key].btn.classList.toggle('is-hot', v > 0 && (k.key === 'error' || k.key === 'waiting_user'));
  }
  const tile = usageTile(state.usage);
  setHidden(n.usage, !tile);
  if (tile) {
    setText(n.usageLabel, tile.label);
    setText(n.usageCount, `${tile.pct}%`);
    const level = tile.pct >= 90 ? 'error' : tile.pct >= 75 ? 'warn' : 'ok';
    setAttr(n.usage, 'data-level', level);
  }

  const filterCount = {
    all: counts.total,
    working: counts.working,
    waiting_user: counts.waiting_user,
    error: counts.error,
    idle: counts.idle,
    done: counts.done,
  };
  for (const f of FILTERS) setText(n.filters[f.id].count, String(filterCount[f.id] || 0));

  const attn = attentionBots(bots);
  setText(n.attnCount, String(attn.length));
  setHidden(n.attnClear, attn.length !== 0);
  syncChildren(n.attnRow, attn, makeAttn, (node, bot) => paintBot(node, bot, state, selected));

  const shown = filterBots(bots, U.filter);
  setText(n.shown, U.filter === 'all' ? `${counts.total}` : `${shown.length}/${counts.total}`);
  if (U.view === 'grid') {
    syncChildren(n.grid, shown, makeCell, (node, bot) => paintBot(node, bot, state, selected));
    n.tableBody.textContent = '';
  } else {
    syncChildren(n.tableBody, shown, makeRow, (node, bot) => paintBot(node, bot, state, selected));
    n.grid.textContent = '';
  }

  const none = counts.total === 0;
  setHidden(n.empty, shown.length !== 0);
  setText(n.empty, none
    ? '還沒有機器人。頻道有狀態之後會出現在這裡。'
    : '這個篩選下面沒有機器人。');
  setHidden(n.demo, !state.demo);
  n.root.classList.toggle('is-demo', !!state.demo);
  stampTimes(state);
}
