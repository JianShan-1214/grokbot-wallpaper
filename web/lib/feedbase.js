// The one address the bots post to and the office reads: FEED_BASE + topic. The setup prompt (PROMPT.md) builds the same
// address and the wallpaper (face/face.js) and the landing default to it too; server/test/feedbase.test.js keeps them all
// equal, so change it here and there together. A link can name another mailbox (a relay, a self-hosted ntfy):
//   #<topic>@<host or https URL>     ?feed=<host or https URL>     #<topic>&ntfy=<https URL> (older links)
// Pure: runs in the browser and in Node (tests).
export const FEED_BASE = 'https://ntfy.sh/';

// Cloudflare status bus (feed-cf/). Off until a human sets both and ships the static site.
// `?cf=<https origin>` or `?cf=http://127.0.0.1:<port>` turns it on for that browser only (staging).
// `?cf=0` forces it off. The hash topic stays the room; the publish token never goes in the link.
export const CF_FEED_BASE = '';
export const CF_FEED_ENABLED = false;
export const CF_POLL_MS = 15000;

const TOPIC = /^[A-Za-z0-9_-]{6,64}$/;

/** 'relay.example.com' | 'https://relay.example.com/x' -> 'https://relay.example.com/x/'; null if not https (or localhost). */
export function feedBase(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep it as typed */ }
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
  } catch { return null; }
}

/** A page's location ({ hash, search }) -> { topic, base } or null. ?feed= holds a base; a bare topic there is an older
 *  wallpaper link (?feed=<topic>) and still names the topic. */
export function feedFromLink({ hash = '', search = '' } = {}) {
  const q = new URLSearchParams(search).get('feed');
  const qBase = q && /[./:]/.test(q) ? feedBase(q) : null;
  const m = /^#([A-Za-z0-9_-]{6,64})(?:@([^&#]+)|&ntfy=([^&#]+))?$/.exec(hash);
  const topic = m ? m[1] : q && TOPIC.test(q) ? q : null;
  if (!topic) return null;
  const base = (m && (feedBase(m[2] ?? m[3]))) || qBase || FEED_BASE;
  return { topic, base, url: base + topic };
}

/** The link form of a base for #<topic>@…: the host (and path) without https://, or '' for the default. */
export function baseTag(base) {
  return !base || base === FEED_BASE ? '' : base.replace(/^https:\/\//, '').replace(/\/$/, '');
}

/** { topic, base, pollMs } when the Cloudflare bus should be read alongside the usual mailboxes, else null.
 *  topicFallback covers a wallpaper that remembered the topic without a hash. */
export function cfBusFromLink({ hash = '', search = '' } = {}, topicFallback = '') {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  const flag = params.get('cf');
  if (flag === '0' || flag === 'off' || flag === 'false') return null;
  const linked = feedFromLink({ hash, search });
  const topic = linked?.topic || (TOPIC.test(topicFallback) ? topicFallback : null);
  if (!topic) return null;
  let raw = null;
  if (flag && flag !== '1' && flag !== 'on' && flag !== 'true') raw = flag;
  else if (flag === '1' || flag === 'on' || flag === 'true' || CF_FEED_ENABLED) raw = CF_FEED_BASE;
  const base = feedBase(raw);
  if (!base) return null;
  return { topic, base: base.replace(/\/$/, ''), pollMs: CF_POLL_MS };
}

/** One short SSE batch from GET /events?stream=sse. Named events are ignored; `id` advances the cursor. */
export function parseFeedSse(text) {
  const messages = [];
  let retry = null;
  let cursor = null;
  for (const block of String(text).split(/\n\n/)) {
    let event = 'message';
    let data = '';
    let id = null;
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const key = at < 0 ? line : line.slice(0, at);
      const val = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (key === 'event') event = val;
      else if (key === 'data') data += val;
      else if (key === 'id') id = val;
      else if (key === 'retry') retry = Number(val);
    }
    if (id) cursor = id;
    if (event === 'message' && data) {
      try { messages.push(JSON.parse(data)); } catch { /* keepalive or junk */ }
    }
  }
  return { messages, retry, cursor };
}
