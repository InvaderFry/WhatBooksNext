import { LayoutChanged, type ParsedPage, type WatchAdapter } from '../core/adapter.ts';
import type { StoreRecord } from '../core/format.ts';

/**
 * GlobalComix (store purchases plan, Stage 2). The owner's purchases page loads its list from
 * `https://api.globalcomix.com/v1/account/digital-purchases?p=N` (30 per page). Version 1 asked for
 * that list itself and the service answered HTTP 400 (2026-11-11): the site adds something of its
 * own to its requests. Copying that would mean handling the site's sign-in, which the plan rules
 * out. So version 2 **makes no requests**: the owner starts on the home page, pastes the script,
 * and goes to My Shelf → Purchases with the site's menu; the script reads the list answers the
 * page itself receives, like the look-around did.
 *
 * From the owner's fourth look-around report (2026-11-11): `payload.results` is a list of purchase
 * records (`id`, `release_id`, `net_price`, `is_downloadable`, `create_time`), each with its
 * `release`: `id`, `title`, `comic_name`, `chapter`, `release_type_name` ("Volume"), `isbn`,
 * `read_url`, `comic_type.name`, and `user_read_status` (`is_complete`,
 * `read_progress_percentage`). Other list answers carry `pagination` (`page`, `per_page`,
 * `total_pages`) and `filters.perpage`. Only purchases are in this list: Gold reading isn't.
 */

export const GLOBALCOMIX_VERSION = '2';

export const globalcomix: WatchAdapter = {
  service: 'globalcomix',
  version: GLOBALCOMIX_VERSION,
  label: 'GlobalComix',
  checkPage(url) {
    if (url.protocol !== 'https:' || !/^(www\.)?globalcomix\.com$/.test(url.hostname))
      return {
        ok: false,
        message:
          'This isn’t GlobalComix. Open https://globalcomix.com (the home page), sign in if asked, then run the script there.',
      };
    if (url.pathname.startsWith('/my-shelf'))
      return {
        ok: false,
        message:
          'Start on the home page: open https://globalcomix.com in this tab (type it in, so the page loads fresh), paste the script there, then go to My Shelf → Purchases with the site’s menu.',
      };
    return { ok: true, region: 'globalcomix.com' };
  },
  matches: (url) =>
    url.hostname === 'api.globalcomix.com' && url.pathname === '/v1/account/digital-purchases',
  parse: parseGlobalComixPage,
};

const str = (v: unknown) =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';

/** What was bought: GlobalComix's release type → the plan's units. */
function unitOf(type: string): NonNullable<StoreRecord['unit']> {
  const t = type.toLowerCase();
  if (/volume|vol\b/.test(t)) return 'volume';
  if (/collection|omnibus|compendium|trade|tpb|bundle|box/.test(t)) return 'collection';
  if (/issue|chapter|episode/.test(t)) return 'issue';
  return 'book';
}

/** Reads one page of the purchases list. Pure, so it's tested on invented answers. */
export function parseGlobalComixPage(body: unknown): ParsedPage {
  const b = (body ?? {}) as {
    meta?: { params?: { p?: unknown } };
    payload?: { results?: unknown; pagination?: { page?: unknown; total_pages?: unknown } | null };
  };
  if (!b.payload || !Array.isArray(b.payload.results))
    throw new LayoutChanged('no payload.results list in the purchases answer');
  const records: StoreRecord[] = [];
  const fields = new Set<string>();
  const labelFor: Record<string, string> = {};
  for (const raw of b.payload.results) {
    const p = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(p)) fields.add(k);
    const rel = (p.release ?? null) as Record<string, unknown> | null;
    if (!rel || typeof rel !== 'object') throw new LayoutChanged('a purchase without its release');
    for (const k of Object.keys(rel)) fields.add(`release.${k}`);
    const id = str(rel.id) || str(p.release_id);
    const series = str(rel.comic_name) || str((rel.comic as { name?: unknown } | null)?.name);
    const own = str(rel.title);
    // A title that's only a number ("Volume 1", "#3") says little alone: put the series first.
    const title =
      own && series && /^(vol\.?|volume|issue|chapter|ch\.?|book|part|#)\s*\d/i.test(own)
        ? `${series}, ${own}`
        : own || series;
    if (!id) throw new LayoutChanged('a purchase without a release ID');
    if (!title) throw new LayoutChanged('a purchase without a title');
    const type = str(rel.release_type_name) || 'unknown type';
    const price = Number(str(p.net_price));
    const free = str(p.net_price) !== '' && Number.isFinite(price) && price === 0;
    const rec: StoreRecord = {
      storeRecordId: id,
      idKind: 'release',
      title,
      unit: unitOf(type),
      // In the store's own list of digital purchases: bought, or unlocked for free for good.
      acquisition: {
        type: free ? 'free_claim' : 'purchase',
        evidence: `GlobalComix digital purchase${free ? ', at no charge' : ''}`,
      },
    };
    if (series && series !== title) rec.series = series;
    const number = str(rel.chapter);
    if (series && /^\d+(\.\d+)?$/.test(number)) rec.seriesIndex = number;
    const isbn = str(rel.isbn).replace(/[^0-9Xx]/g, '');
    if (isbn.length === 10 || isbn.length === 13) rec.isbn = isbn;
    const kind = str((rel.comic_type as { name?: unknown } | null)?.name).toLowerCase();
    if (kind === 'comic' || kind === 'manga') rec.kind = kind;
    const bought = /^(\d{4}-\d{2}-\d{2})/.exec(str(p.create_time));
    if (bought) rec.acquiredAt = { value: bought[1]!, precision: 'day' };
    const status = (rel.user_read_status ?? null) as Record<string, unknown> | null;
    if (status) {
      const pct = Number(status.read_progress_percentage);
      if (Number(status.is_complete) === 1) rec.readingStatus = 'finished';
      else if (Number.isFinite(pct) && pct > 0) rec.readingStatus = 'in_progress';
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) rec.progressPercent = pct;
    }
    const read = str(rel.read_url);
    if (/^https:\/\/(www\.)?globalcomix\.com\/read\//.test(read)) rec.readUrl = read;
    records.push(rec);
    labelFor[`release:${id}`] = `${type}${free ? ' (free)' : ''}`;
  }
  // Which page this is, and whether it's the last: from `pagination`, else from the page size.
  const pg = (b.payload.pagination ?? null) as {
    page?: unknown;
    per_page?: unknown;
    total_pages?: unknown;
  } | null;
  const filters = ((b.payload as { filters?: unknown }).filters ?? null) as {
    perpage?: unknown;
  } | null;
  const page = Number(pg?.page ?? b.meta?.params?.p ?? NaN);
  const pages = Number(pg?.total_pages ?? NaN);
  const perPage = Number(pg?.per_page ?? filters?.perpage ?? NaN);
  const n = b.payload.results.length;
  const lastPage = Number.isFinite(pages)
    ? page >= pages
    : n === 0 || (Number.isFinite(perPage) && n < perPage);
  const next = Number.isFinite(page) && !lastPage ? String(page + 1) : null;
  return {
    records,
    excluded: [],
    // Unknown page number: never claims to be the end of the list.
    next: Number.isFinite(page) ? next : '?',
    fields: [...fields].sort(),
    labels: [],
    labelFor,
    ...(Number.isFinite(page) ? { page } : {}),
  };
}
