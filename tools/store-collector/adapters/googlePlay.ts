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

export const GOOGLE_PLAY_VERSION = '1';

/** What the page side reads from one card. Plain data, so the reading rules are tested here. */
export interface PlayCard {
  /** Classes of the card's `div.card` (e.g. ["card", "ebook"]). */
  classes: string[];
  /** The card's reader link (`a.title`, else `a.cover-link`). */
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

/** Reads the cards on screen now. Pure, so it's tested on invented cards. */
export function parsePlayCards(cards: unknown): ParsedPage {
  if (!Array.isArray(cards)) throw new LayoutChanged('no list of book cards');
  const records: StoreRecord[] = [];
  const fields = new Set<string>();
  const labels: string[] = [];
  for (const raw of cards) {
    const c = raw as Partial<PlayCard>;
    for (const [k, v] of Object.entries(c))
      if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) fields.add(k);
    let id: string | null = null;
    try {
      const u = new URL(String(c.href ?? ''));
      if (u.hostname === 'play.google.com' && u.pathname.startsWith('/books/reader'))
        id = u.searchParams.get('id');
    } catch {
      /* not a link */
    }
    if (!id) throw new LayoutChanged('a book card without a reader link');
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    if (!title) throw new LayoutChanged('a book card without a title');
    const types = (Array.isArray(c.classes) ? c.classes : []).filter((x) =>
      CARD_TYPES.includes(String(x).toLowerCase()),
    );
    labels.push(types.length ? types.join('+') : 'no card type');
    // Listed under Purchases (uploads are under another filter). An ebook card is a purchase;
    // any other kind of card is shown to the owner to decide, never guessed.
    const ebook = types.length === 1 && types[0] === 'ebook';
    const rec: StoreRecord = {
      storeRecordId: id,
      idKind: 'volume',
      title,
      unit: 'book',
      acquisition: {
        type: ebook ? 'purchase' : 'uncertain',
        evidence: `listed under Purchases; card type ${types.join('+') || 'not shown'}`,
      },
      // The reader link as the page gives it, reduced to the book's own ID.
      readUrl: `https://play.google.com/books/reader?id=${encodeURIComponent(id)}`,
    };
    const authors = (Array.isArray(c.authors) ? c.authors : [])
      .map((a) => String(a).trim())
      .filter(Boolean);
    if (authors.length) rec.creators = authors.map((name) => ({ name, role: 'author' as const }));
    records.push(rec);
  }
  return { records, excluded: [], next: null, fields: [...fields].sort(), labels };
}
