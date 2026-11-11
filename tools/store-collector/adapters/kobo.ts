import { LayoutChanged, type Adapter, type ParsedPage } from '../core/adapter.ts';
import type { StoreRecord } from '../core/format.ts';

/**
 * Kobo, kobo.com/us (store purchases plan, Stage 2). It runs on the owner's Books library,
 * https://www.kobo.com/us/en/library/books, and fetches the same library pages that page fetches
 * while you scroll (`?pageNumber=N`, plain HTML, 24 books each). It reads and changes nothing:
 * every button on the card (mark as finished, remove, archive) is left alone.
 *
 * From the owner's look-around reports (2026-11-11): one `li.item-wrapper.book` per book, whose
 * `data-track-info` JSON holds `productId` (36 characters), `title`, `readStatus` and the store's
 * `totalBooks`; `h2.title a` links the book's page (`/us/en/ebook/<slug>`); `a.contributor-name`
 * per author; `a.button.readnow` links Kobo's web reader (`readnow.kobo.com/<id>`); and
 * `span.item-status` shows a status like "Unread". NOT CHECKED YET as a scan (A2).
 */

export const KOBO_VERSION = '1';

/** What the page side reads from one card. Plain data, so the reading rules are tested here. */
export interface KoboCard {
  /** Classes of the card's `li` (e.g. ["item-wrapper", "book"]). */
  classes: string[];
  /** `data-track-info` JSON on the `li`, as text. */
  trackInfo: string | null;
  /** `h2.title a`: text and link. */
  title: string;
  pageHref: string | null;
  /** Each `a.contributor-name`'s text. */
  authors: string[];
  /** `a.button.readnow`'s link. */
  readHref: string | null;
  /** `span.item-status`'s text (e.g. "Unread"). */
  status: string;
  /**
   * Short texts of the card's badges, ribbons and tags (not its title), lowercased: where a
   * preview or Kobo Plus mark would show.
   */
  marks: string[];
}

/** Marks that say a card isn't owned for good. Seeing one makes the book uncertain. */
const NOT_OWNED = /preview|sample|kobo ?plus|subscription|borrow|loan|rental/i;

export const kobo: Adapter = {
  service: 'kobo',
  version: KOBO_VERSION,
  label: 'Kobo',
  checkPage(url) {
    if (url.protocol !== 'https:' || url.hostname !== 'www.kobo.com')
      return {
        ok: false,
        message:
          'This isn’t Kobo. Open https://www.kobo.com/us/en/library/books in this tab, sign in if Kobo asks, then run the script again.',
      };
    if (!/^\/[a-z]{2}\/[a-z]{2}\/library\/books\/?$/.test(url.pathname))
      return {
        ok: false,
        message:
          'Open your Books library: go to https://www.kobo.com/us/en/library/books in this tab, then run the script again.',
      };
    return { ok: true, region: `kobo.com/${url.pathname.split('/')[1]}` };
  },
  firstCursor: '1',
  request(cursor, page) {
    const u = new URL(page.pathname, page.origin);
    u.searchParams.set('pageNumber', cursor);
    return { url: u.href, init: { method: 'GET', headers: { accept: 'text/html' } } };
  },
  answer: 'html',
  // A page past the end may repeat the last one: nothing new means the list has ended.
  endsWhenNothingNew: true,
  parse: parseKoboPage,
};

/** Kobo's status → reading status. Only the clear ones; anything else is left out. */
function statusOf(s: string): StoreRecord['readingStatus'] | undefined {
  const t = s.trim().toLowerCase();
  if (t === 'unread') return 'not_started';
  if (t === 'finished' || t === 'read') return 'finished';
  if (t === 'reading' || t === 'in progress' || /^\d{1,2}% read$/.test(t)) return 'in_progress';
  return undefined;
}

/** Reads one library page: `{ page, cards }` from the page side. Pure, tested on invented cards. */
export function parseKoboPage(data: unknown): ParsedPage {
  const d = (data ?? {}) as { page?: unknown; cards?: unknown };
  if (!Array.isArray(d.cards) || typeof d.page !== 'number')
    throw new LayoutChanged('no list of book cards');
  const records: StoreRecord[] = [];
  const fields = new Set<string>();
  const labelFor: Record<string, string> = {};
  let storeTotal: number | undefined;
  for (const raw of d.cards) {
    const c = (raw ?? {}) as Partial<KoboCard>;
    let track: Record<string, unknown> = {};
    try {
      track = JSON.parse(c.trackInfo ?? '{}') as Record<string, unknown>;
    } catch {
      /* checked below */
    }
    const has = [
      ...Object.entries(c)
        .filter(
          ([k, v]) =>
            k !== 'trackInfo' && v !== null && v !== '' && !(Array.isArray(v) && !v.length),
        )
        .map(([k]) => k),
      ...Object.keys(track).map((k) => `trackInfo.${k}`),
    ].sort();
    for (const k of has) fields.add(k);
    const id = typeof track.productId === 'string' ? track.productId.trim() : '';
    const title =
      (c.title ?? '').trim() || (typeof track.title === 'string' ? track.title.trim() : '');
    if (!id || !title)
      throw new LayoutChanged(
        `a book card without ${!id ? 'a product ID' : 'a title'} (the card had: ${has.join(', ') || 'nothing'})`,
      );
    if (typeof track.totalBooks === 'number') storeTotal = track.totalBooks;
    const classes = (Array.isArray(c.classes) ? c.classes : []).filter((x) => x !== 'item-wrapper');
    const marks = (Array.isArray(c.marks) ? c.marks : []).filter((m) => NOT_OWNED.test(m));
    const plainBook = classes.length === 1 && classes[0] === 'book' && marks.length === 0;
    const kinds = [...classes, ...marks.map((m) => (m.match(NOT_OWNED)?.[0] ?? '').toLowerCase())];
    const rec: StoreRecord = {
      storeRecordId: id,
      idKind: 'product',
      title,
      unit: 'book',
      // In the Books library with no preview or Kobo Plus mark: owned (bought or claimed free).
      // Anything else goes to the owner to decide.
      acquisition: {
        type: plainBook ? 'purchase' : 'uncertain',
        evidence: plainBook
          ? 'in your Kobo Books library, with no preview or Kobo Plus mark'
          : `in your Kobo Books library, marked ${kinds.join(', ') || 'differently'}`,
      },
    };
    const authors = (Array.isArray(c.authors) ? c.authors : [])
      .map((a) => String(a).trim())
      .filter(Boolean);
    if (authors.length) rec.creators = authors.map((name) => ({ name, role: 'author' as const }));
    try {
      const r = new URL(String(c.readHref ?? ''));
      // The web reader link without its tracking and return-address parts.
      if (r.protocol === 'https:' && r.hostname === 'readnow.kobo.com')
        rec.readUrl = `${r.origin}${r.pathname}`;
    } catch {
      /* no reader link: some books can't be read on the web */
    }
    try {
      const p = new URL(String(c.pageHref ?? ''));
      if (p.protocol === 'https:' && p.hostname === 'www.kobo.com')
        rec.pageUrl = `${p.origin}${p.pathname}`;
    } catch {
      /* no page link */
    }
    const status = statusOf(c.status ?? '');
    if (status) rec.readingStatus = status;
    records.push(rec);
    labelFor[`product:${id}`] = `${kinds.join('+') || 'no type'}${status ? ` (${status})` : ''}`;
  }
  return {
    records,
    excluded: [],
    // Until a page comes back empty (or brings nothing new).
    next: d.cards.length > 0 ? String(d.page + 1) : null,
    fields: [...fields],
    labels: [],
    labelFor,
    ...(storeTotal !== undefined ? { storeTotal } : {}),
  };
}
