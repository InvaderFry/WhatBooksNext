import { LayoutChanged, type CardAdapter, type ParsedPage } from '../core/adapter.ts';
import type { StoreRecord } from '../core/format.ts';

/**
 * Google Play Books (store purchases plan, Stage 2). It runs on the owner's purchases,
 * https://play.google.com/books?source=purchases, which leaves out uploads (the owner uploads
 * copies of their own files, which must not come in as purchases). The page shows every book as a
 * card, loaded at once, so the collector only scrolls and reads the cards: no requests at all.
 *
 * From the owner's look-around report (2026-11-11): one `gpb-volume-card` per book, holding
 * `div.card.<type>` (22 of 23 were `ebook`), `a.title` and `a.cover-link` linking to
 * `play.google.com/books/reader?id=<volume ID>`, and `a.author` linking to an author page.
 * NOT CHECKED YET as a scan: the owner's first run (A2) checks it.
 */

// 2: cards not yet filled in (placeholders below the fold) are skipped; any Google book link with an
// id counts (not only the reader); a failure says which parts the card had. The owner's first run
// of version 1 stopped at a card with no link (2026-11-11).
export const GOOGLE_PLAY_VERSION = '2';

/** What the page side reads from one card. Plain data, so the reading rules are tested here. */
export interface PlayCard {
  /** Classes of the card's `div.card` (e.g. ["card", "ebook"]). */
  classes: string[];
  /** The card's book link (`a.title`, else `a.cover-link`, else any link with an id). */
  href: string | null;
  /** `a.title`'s title attribute or text. */
  title: string;
  /** Each `a.author`'s title attribute or text. */
  authors: string[];
}

/** Class names that say what a card is. Only these are reported; the rest are layout. */
const CARD_TYPES = ['ebook', 'audiobook', 'sample', 'preview', 'upload', 'uploaded', 'rental'];

export const googlePlay: CardAdapter = {
  service: 'google_play',
  version: GOOGLE_PLAY_VERSION,
  label: 'Google Play Books',
  checkPage(url) {
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'play.google.com' ||
      !url.pathname.startsWith('/books')
    )
      return {
        ok: false,
        message:
          'This isn’t Google Play Books. Open https://play.google.com/books?source=purchases in this tab, sign in if Google asks, then run the script again.',
      };
    if (url.searchParams.get('source') !== 'purchases')
      return {
        ok: false,
        message:
          'Open your purchases only (so your own uploads stay out): go to https://play.google.com/books?source=purchases in this tab, then run the script again.',
      };
    return { ok: true, region: 'play.google.com (purchases)' };
  },
  parse: parsePlayCards,
};

/** A Google Play book link's volume ID and what it opens; null for any other link. */
function bookLink(href: unknown): { id: string; path: string; reader: boolean } | null {
  try {
    const u = new URL(String(href ?? ''));
    const id = u.searchParams.get('id');
    if (u.protocol !== 'https:' || u.hostname !== 'play.google.com' || !id) return null;
    if (!/^\/(books|store\/books)(\/|$)/.test(u.pathname)) return null;
    return { id, path: u.pathname, reader: u.pathname.startsWith('/books/reader') };
  } catch {
    return null;
  }
}

/** Reads the cards on screen now. Pure, so it's tested on invented cards. */
export function parsePlayCards(cards: unknown): ParsedPage {
  if (!Array.isArray(cards)) throw new LayoutChanged('no list of book cards');
  const records: StoreRecord[] = [];
  const fields = new Set<string>();
  const labelFor: Record<string, string> = {};
  for (const raw of cards) {
    const c = (raw ?? {}) as Partial<PlayCard>;
    const has = Object.entries(c)
      .filter(
        ([, v]) =>
          v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
      )
      .map(([k]) => k);
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    // Not filled in yet (the page fills cards in as they scroll into view): read it later.
    if (!c.href && !title) continue;
    for (const k of has) fields.add(k);
    const link = bookLink(c.href);
    if (!link || !title)
      throw new LayoutChanged(
        `a book card ${!link ? 'without a Google book link' : 'without a title'} (the card had: ${has.sort().join(', ') || 'nothing'})`,
      );
    const types = (Array.isArray(c.classes) ? c.classes : []).filter((x) =>
      CARD_TYPES.includes(String(x).toLowerCase()),
    );
    // Listed under Purchases (uploads are under another filter). An ebook card is a purchase;
    // any other kind of card is shown to the owner to decide, never guessed.
    const ebook = types.length === 1 && types[0] === 'ebook';
    const rec: StoreRecord = {
      storeRecordId: link.id,
      idKind: 'volume',
      title,
      unit: 'book',
      acquisition: {
        type: ebook ? 'purchase' : 'uncertain',
        evidence: `listed under Purchases; card type ${types.join('+') || 'not shown'}`,
      },
    };
    // The link as the page gives it, reduced to the book's own ID.
    if (link.reader)
      rec.readUrl = `https://play.google.com/books/reader?id=${encodeURIComponent(link.id)}`;
    else rec.pageUrl = `https://play.google.com${link.path}?id=${encodeURIComponent(link.id)}`;
    const authors = (Array.isArray(c.authors) ? c.authors : [])
      .map((a) => String(a).trim())
      .filter(Boolean);
    if (authors.length) rec.creators = authors.map((name) => ({ name, role: 'author' as const }));
    records.push(rec);
    // For the report: the card type and which kind of page its link opens (never the ID).
    labelFor[`volume:${link.id}`] = `${types.join('+') || 'no card type'} via ${link.path}`;
  }
  return { records, excluded: [], next: null, fields: [...fields].sort(), labels: [], labelFor };
}
