/**
 * The look-around script's privacy rules (store purchases plan, Stage 2): it reports a store
 * page's structure so an adapter can be written, and never a value that could name a book, an ID
 * or the owner. Everything it prints goes through these functions.
 */

/** Words stores use for how a book was acquired or what it is: labels, never titles. */
const LABEL_WORDS = new Set(
  [
    'purchase',
    'purchased',
    'sample',
    'free',
    'ebook',
    'audiobook',
    'book',
    'comic',
    'manga',
    'preview',
    'rental',
    'rented',
    'owned',
    'borrowed',
    'loan',
    'subscription',
    'upload',
    'uploaded',
    'archived',
    'active',
    'preorder',
    'gift',
    'promotion',
    'issue',
    'volume',
    'collection',
    'chapter',
    'series',
    'finished',
    'reading',
    'unread',
    'read',
    'true',
    'false',
    'plus',
    'kobo plus',
    'unlimited',
    'kindle unlimited',
    'prime reading',
    'free sample',
    'downloaded',
    'returned',
    'expired',
    'subscribed',
    'unlocked',
    'locked',
    'premium',
  ].map((w) => w.toLowerCase()),
);

/**
 * A string value as it may appear in the report: a known label word, or an UPPER_SNAKE label
 * (like PURCHASE_TYPE_SAMPLE). Anything else is only described ("text, 10–50 characters").
 */
export function describeString(s: string, ownHosts: string[]): string {
  const t = s.trim();
  if (LABEL_WORDS.has(t.toLowerCase())) return JSON.stringify(t);
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t) && t.length <= 40) return JSON.stringify(t);
  if (/^https?:\/\//i.test(t)) return `link ${maskUrl(t, ownHosts)}`;
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(t)) return 'date text';
  if (/^\d{10,13}$/.test(t)) return `digits(${t.length})`;
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number text';
  if (/^\d{1,3}(\.\d+)?\s?%$/.test(t)) return 'percent text';
  if (/^[A-Za-z0-9_-]{8,}$/.test(t) && /\d/.test(t)) return `id-like(${t.length})`;
  return `text(${t.length < 10 ? '<10' : t.length < 50 ? '10–50' : t.length < 200 ? '50–200' : '200+'})`;
}

/** A key may be shown unless it looks like an ID, an email or anything not a plain name. */
export function safeKey(k: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$-]{0,40}$/.test(k) && (k.match(/\d/g) ?? []).length < 3;
}

/**
 * A URL as host and path pattern: segments that look like IDs or slugs become :id or :slug, and
 * query values are hidden except a few that name methods (Google's rpcids) or settings.
 */
export function maskUrl(raw: string, ownHosts: string[]): string {
  let u: URL;
  try {
    u = new URL(raw, 'https://invalid.example/');
  } catch {
    return '(not a URL)';
  }
  const host = ownHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    ? u.hostname
    : `other host (${u.hostname.split('.').slice(-2).join('.')})`;
  const path = u.pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[a-z]{2}(-[a-z]{2})?$/i.test(seg) || /^[a-z_]{1,30}$/i.test(seg)) return seg;
      if (/^v\d{1,2}$/i.test(seg)) return seg;
      if (/\d/.test(seg) && seg.length >= 4) return ':id';
      return ':slug';
    })
    .join('/');
  const keep = new Set([
    'rpcids',
    'source-path',
    'type',
    'sort',
    'sortType',
    'libraryType',
    'page',
    'limit',
    'offset',
    'pageSize',
    'querySize',
  ]);
  const q = [...u.searchParams.keys()]
    .filter((k, i, a) => a.indexOf(k) === i)
    .map((k) => {
      if (!safeKey(k)) return ':key=…';
      const v = u.searchParams.get(k) ?? '';
      return keep.has(k) && /^[A-Za-z0-9_,.-]{0,40}$/.test(v) ? `${k}=${v}` : `${k}=…`;
    });
  return `${host}${path}${q.length ? `?${q.join('&')}` : ''}`;
}
