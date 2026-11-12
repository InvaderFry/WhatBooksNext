import { LayoutChanged, type Adapter, type ParsedPage } from '../core/adapter.ts';
import type { ExcludedReason, StoreRecord } from '../core/format.ts';

/**
 * Kindle on amazon.com (store purchases plan, Stage 1). It runs on the Kindle web library,
 * https://read.amazon.com/kindle-library, and makes the same read-only request that page makes to
 * list the library: a GET of `/kindle-library/search` (a search; it changes nothing). It never
 * clicks, buys, returns, deletes, lends, downloads or marks anything.
 *
 * NOT CHECKED YET on a signed-in account: the request and its fields come from how the page is
 * publicly described. The owner's first run (owner action A2) confirms them; until then the
 * fingerprint stops the scan the moment anything differs.
 */

export const KINDLE_VERSION = '1';

/** Library pages this adapter knows. Other Amazon countries are added once one is checked. */
const HOSTS = ['read.amazon.com'];

const PAGE_SIZE = 50;

/**
 * How Amazon labels the way a book came into the library (`originType`). Anything not listed
 * goes to review as uncertain: a purchase is never guessed.
 */
const ORIGINS: Record<string, { type: 'purchase' } | { excluded: ExcludedReason }> = {
  PURCHASE: { type: 'purchase' },
  KINDLE_UNLIMITED: { excluded: 'subscription' },
  COMICS_UNLIMITED: { excluded: 'subscription' },
  PRIME: { excluded: 'subscription' },
  PRIME_READING: { excluded: 'subscription' },
  SAMPLE: { excluded: 'sample' },
  LENDING: { excluded: 'loan' },
  LOAN: { excluded: 'loan' },
  PUBLIC_LIBRARY_LENDING: { excluded: 'loan' },
  KINDLE_OWNERS_LENDING_LIBRARY: { excluded: 'loan' },
  PDOCS: { excluded: 'personal_document' },
  PERSONAL_DOCUMENT: { excluded: 'personal_document' },
};

export const kindle: Adapter = {
  service: 'kindle',
  version: KINDLE_VERSION,
  label: 'Kindle',
  checkPage(url) {
    if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname))
      return {
        ok: false,
        message:
          'This isn’t the Kindle library. Open https://read.amazon.com/kindle-library in this tab, sign in if Amazon asks, then run the script again.',
      };
    if (!url.pathname.startsWith('/kindle-library'))
      return {
        ok: false,
        message:
          'Open your library first: go to https://read.amazon.com/kindle-library in this tab, then run the script again.',
      };
    return { ok: true, region: url.hostname };
  },
  firstCursor: '0',
  request(cursor, page) {
    const u = new URL('/kindle-library/search', page.origin);
    u.searchParams.set('query', '');
    u.searchParams.set('libraryType', 'BOOKS');
    u.searchParams.set('paginationToken', cursor);
    u.searchParams.set('sortType', 'recency');
    u.searchParams.set('querySize', String(PAGE_SIZE));
    return { url: u.href, init: { method: 'GET', headers: { accept: 'application/json' } } };
  },
  parse: parseKindlePage,
};

/** Reads one answer of the Kindle library search. Pure, so it's tested on invented answers. */
export function parseKindlePage(body: unknown): ParsedPage {
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { itemsList?: unknown }).itemsList)
  )
    throw new LayoutChanged('no itemsList in the library answer');
  const b = body as { itemsList: unknown[]; paginationToken?: unknown };
  const records: StoreRecord[] = [];
  const excluded: ParsedPage['excluded'] = [];
  const fields = new Set<string>();
  const labels: string[] = [];
  for (const raw of b.itemsList) {
    if (!raw || typeof raw !== 'object') throw new LayoutChanged('an item that isn’t a record');
    const it = raw as Record<string, unknown>;
    for (const k of Object.keys(it)) fields.add(k);
    const asin = typeof it.asin === 'string' ? it.asin.trim() : '';
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!asin) throw new LayoutChanged('an item without asin');
    if (!title) throw new LayoutChanged('an item without title');
    const origin = typeof it.originType === 'string' ? it.originType : '';
    const resource = typeof it.resourceType === 'string' ? it.resourceType : '';
    labels.push(`${origin || 'no originType'}/${resource || 'no resourceType'}`);
    const known = ORIGINS[origin];
    const reason: ExcludedReason | null = /SAMPLE/i.test(resource)
      ? 'sample'
      : /PDOC|PERSONAL/i.test(resource)
        ? 'personal_document'
        : known && 'excluded' in known
          ? known.excluded
          : null;
    if (reason) {
      excluded.push({ id: `asin:${asin}`, reason });
      continue;
    }
    const evidence = `originType ${origin || 'missing'}, resourceType ${resource || 'missing'}`;
    const rec: StoreRecord = {
      storeRecordId: asin,
      idKind: 'asin',
      title,
      unit: 'book',
      acquisition: { type: known ? 'purchase' : 'uncertain', evidence },
    };
    const creators = authorsOf(it.authors);
    if (creators.length) rec.creators = creators;
    if (typeof it.percentageRead === 'number' && it.percentageRead >= 0 && it.percentageRead <= 100)
      rec.progressPercent = it.percentageRead;
    // Only the reader link the page itself gives: no link is built from the ASIN until that
    // pattern is checked (Store links).
    if (
      typeof it.webReaderUrl === 'string' &&
      /^https:\/\/read\.amazon\.com\//.test(it.webReaderUrl)
    )
      rec.readUrl = it.webReaderUrl;
    records.push(rec);
  }
  const token = b.paginationToken;
  const next =
    b.itemsList.length > 0 &&
    (typeof token === 'string' || typeof token === 'number') &&
    String(token)
      ? String(token)
      : null;
  return { records, excluded, next, fields: [...fields].sort(), labels };
}

/**
 * Amazon lists authors as "Last, First:" with a trailing colon. Shown as "First Last"; anything
 * else is kept as written. The role is "author" because the store calls them authors.
 */
function authorsOf(v: unknown): NonNullable<StoreRecord['creators']> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().replace(/:+$/, '').trim())
    .filter(Boolean)
    .map((x) => {
      const parts = x.split(',').map((p) => p.trim());
      const name = parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : x;
      return { name, role: 'author' as const };
    });
}
