import { LayoutChanged, type Adapter, type ParsedPage } from '../core/adapter.ts';
import type { StoreRecord } from '../core/format.ts';

/**
 * GlobalComix (store purchases plan, Stage 2). It runs on the owner's purchases page,
 * https://globalcomix.com/my-shelf/purchases, and asks for the same list that page loads:
 * `GET https://api.globalcomix.com/v1/account/digital-purchases?p=N` (30 per page). It reads and
 * changes nothing. Only purchases are in this list: Gold subscription reading isn't.
 *
 * From the owner's fourth look-around report (2026-11-11): `payload.results` is a list of purchase
 * records (`id`, `release_id`, `net_price`, `is_downloadable`, `create_time`), each with its
 * `release`: `id`, `title`, `comic_name`, `chapter`, `release_type_name` ("Volume"), `isbn`,
 * `read_url`, `comic_type.name`, and `user_read_status` (`is_complete`,
 * `read_progress_percentage`). Other list answers on the site carry `pagination` (`page`,
 * `total_pages`); this one's wasn't seen, so either way works. NOT CHECKED YET as a scan (A2).
 */

export const GLOBALCOMIX_VERSION = '1';

const API = 'https://api.globalcomix.com/v1/account/digital-purchases';

export const globalcomix: Adapter = {
  service: 'globalcomix',
  version: GLOBALCOMIX_VERSION,
  label: 'GlobalComix',
  checkPage(url) {
    if (url.protocol !== 'https:' || !/^(www\.)?globalcomix\.com$/.test(url.hostname))
      return {
        ok: false,
        message:
          'This isn’t GlobalComix. Open https://globalcomix.com/my-shelf/purchases in this tab, sign in if asked, then run the script again.',
      };
    if (!url.pathname.startsWith('/my-shelf/purchases'))
      return {
        ok: false,
        message:
          'Open your purchases: go to https://globalcomix.com/my-shelf/purchases in this tab, then run the script again.',
      };
    return { ok: true, region: 'globalcomix.com' };
  },
  firstCursor: '1',
  request(cursor) {
    const u = new URL(API);
    u.searchParams.set('p', cursor);
    return { url: u.href, init: { method: 'GET', headers: { accept: 'application/json' } } };
  },
  // A page past the end may come back empty or repeat: either way the list has ended.
  endsWhenNothingNew: true,
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
  const pg = b.payload.pagination;
  const page = Number(pg?.page ?? b.meta?.params?.p ?? NaN);
  const pages = Number(pg?.total_pages ?? NaN);
  const next =
    Number.isFinite(page) && Number.isFinite(pages)
      ? page < pages
        ? String(page + 1)
        : null
      : b.payload.results.length > 0 && Number.isFinite(page)
        ? String(page + 1)
        : null;
  return { records, excluded: [], next, fields: [...fields].sort(), labels: [], labelFor };
}
