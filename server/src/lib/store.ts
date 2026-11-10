import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { samePerson } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import { applyUserPatch, KINDS } from './progress.ts';

/**
 * Books owned in a store app rather than as files (PLAN.md §14): Kindle, Kobo, GlobalComix,
 * Apple Books, Google Play, or another app. They're recommended like any book, labelled "In
 * Kindle" (a label, never a link), and count as ready to read only once the owner says they
 * can read them there (§13.1). What the owner types is kept as typed: no invented identity.
 */

export const STORES = [
  'kindle',
  'kobo',
  'globalcomix',
  'apple_books',
  'google_play',
  'other',
] as const;
export type Store = (typeof STORES)[number];

/** "Amazon", "kindle", "Apple Books", "iBooks", "Play Books"… → our store names. */
export function storeFrom(text: string | null | undefined): Store {
  const t = (text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return 'other';
  if (/kindle|amazon/.test(t)) return 'kindle';
  if (/kobo/.test(t)) return 'kobo';
  if (/globalcomix/.test(t)) return 'globalcomix';
  if (/apple|ibooks/.test(t)) return 'apple_books';
  if (/google|playbooks/.test(t)) return 'google_play';
  return 'other';
}

export function kindFrom(text: string | null | undefined): string | null {
  const t = (text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t === 'selfhelp') return 'self_help';
  if (t === 'graphicnovel' || t === 'comics') return 'comic';
  if (t === 'novel') return 'fiction';
  return (KINDS as readonly string[]).includes(t) ? t : null;
}

export const normIsbn = (s: string | null | undefined): string | null => {
  const v = (s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return v.length === 10 || v.length === 13 ? v : null;
};

export interface StoreFields {
  title: string;
  author?: string | null;
  kind?: string | null;
  isbn?: string | null;
  series?: string | null;
  number?: string | null;
  store: Store;
  /** The owner can read it there now (Ready to read, §13.1). */
  readable?: boolean;
}

export function validateFields(b: Record<string, unknown>): StoreFields {
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const title = text(b.title, 500);
  if (!title) throw new HttpError(400, 'A title is needed.');
  const store =
    typeof b.store === 'string' && (STORES as readonly string[]).includes(b.store)
      ? (b.store as Store)
      : storeFrom(String(b.store ?? ''));
  const number = text(b.number, 20);
  if (number && !/^\d+(\.\d+)?$/.test(number))
    throw new HttpError(400, 'The number in the series should be like 3 or 1.5.');
  return {
    title,
    author: text(b.author, 300),
    kind: kindFrom(text(b.kind, 40)),
    isbn: normIsbn(text(b.isbn, 40)),
    series: text(b.series, 300),
    number,
    store,
    readable: b.readable === true,
  };
}

/** A place to read an item: a store, readable there or not yet confirmed. */
export function addLocation(db: DB, itemId: string, store: Store, readable = false): string {
  const existing = db
    .prepare("SELECT id FROM locations WHERE item_id = ? AND kind = 'store' AND store = ?")
    .pluck()
    .get(itemId, store) as string | undefined;
  const now = nowIso();
  if (existing) {
    if (readable)
      db.prepare('UPDATE locations SET confirmed_readable = 1, updated_at = ? WHERE id = ?').run(
        now,
        existing,
      );
    return existing;
  }
  const id = newId();
  db.prepare(
    `INSERT INTO locations (id, item_id, kind, store, confirmed_readable, created_at, updated_at)
     VALUES (?, ?, 'store', ?, ?, ?, ?)`,
  ).run(id, itemId, store, readable ? 1 : 0, now, now);
  return id;
}

/** A new item for a store title, with its place to read. */
export function createStoreItem(db: DB, f: StoreFields): string {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO items (id, kind, kind_source, title, title_source, creators, series_hint,
       volume_label, identifiers, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.kind ?? null,
    f.kind ? 'owner' : null,
    f.title,
    JSON.stringify(f.author ? [{ name: f.author }] : []),
    f.series ?? null,
    f.series ? (f.number ?? null) : null,
    JSON.stringify(f.isbn ? { isbn: [f.isbn] } : {}),
    now,
    now,
  );
  // The kind the owner typed is theirs: it wins over any later guess.
  if (f.kind) applyUserPatch(db, id, { kindOverride: f.kind });
  addLocation(db, id, f.store, f.readable);
  return id;
}

/**
 * Every ISBN in the library (typed, imported, or inside an EPUB, however it's written there) and
 * the items holding it. Built once per import, so a big file stays quick.
 */
export function isbnIndex(db: DB): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (raw: string, item: string) => {
    const v = normIsbn(raw.replace(/^urn:isbn:/i, ''));
    if (!v) return;
    if (!out.has(v)) out.set(v, new Set());
    out.get(v)!.add(item);
  };
  for (const r of db
    .prepare("SELECT id, identifiers FROM items WHERE identifiers != '{}'")
    .all() as { id: string; identifiers: string }[])
    for (const x of parseJson<{ isbn?: string[] }>(r.identifiers, {}).isbn ?? []) add(x, r.id);
  for (const r of db
    .prepare(
      `SELECT x.item_id, f.metadata FROM files f JOIN item_files x ON x.file_id = f.id
       WHERE f.metadata LIKE '%identifiers%'`,
    )
    .all() as { item_id: string; metadata: string }[])
    for (const x of parseJson<{ identifiers?: { value: string }[] }>(r.metadata, {}).identifiers ??
      [])
      add(x.value, r.item_id);
  return out;
}

type TitleIndex = Map<string, { id: string; names: string[] }[]>;

/** Every item by normalised title, built once per import. */
export function titleIndex(db: DB): TitleIndex {
  const out: TitleIndex = new Map();
  for (const r of db
    .prepare(
      `SELECT i.id, COALESCE(u.title_override, i.title) AS title, i.creators FROM items i
       LEFT JOIN user_item u ON u.item_id = i.id`,
    )
    .all() as { id: string; title: string; creators: string }[]) {
    const key = titleCompareKey(r.title);
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out
      .get(key)!
      .push({ id: r.id, names: parseJson<{ name: string }[]>(r.creators, []).map((c) => c.name) });
  }
  return out;
}

/** Items with the same title (normalised) and, when both name one, the same author. */
export function itemsWithTitle(
  index: TitleIndex,
  title: string,
  author: string | null | undefined,
): string[] {
  return (index.get(titleCompareKey(title)) ?? [])
    .filter((r) => !author || r.names.length === 0 || r.names.some((n) => samePerson(n, author)))
    .map((r) => r.id);
}

// ---- CSV (§14): title, author, store, kind, progress, isbn, series, series_index, rating, note --

/** A small RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const t = text.replace(/^\uFEFF/, ''); // a byte-order mark from Excel
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** "read", "finished", "currently-reading", "to-read", "dnf"… → our progress, or null. */
export function progressFrom(text: string | undefined): string | null {
  const t = (text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (['read', 'finished', 'done', 'completed'].includes(t)) return 'finished';
  if (['reading', 'currentlyreading', 'started', 'intoit'].includes(t)) return 'into_it';
  if (['halfway'].includes(t)) return 'halfway';
  if (['nearlydone', 'almostdone'].includes(t)) return 'nearly_done';
  if (['sampled'].includes(t)) return 'sampled';
  if (['dnf', 'didnotfinish', 'abandoned'].includes(t)) return 'dnf';
  if (['toread', 'unread', 'notstarted', 'wanttoread', 'owned'].includes(t)) return 'not_started';
  return null;
}

/**
 * Ratings converted explicitly (§14): "8" or "8/10" is out of 10; "4/5", "4 stars" or "★★★★" is
 * out of 5 and doubled. Anything else is no rating, never a guess.
 */
export function ratingFrom(text: string | undefined): number | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const stars = [...t].filter((c) => c === '★').length;
  if (stars) return Math.min(10, stars * 2);
  let m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*5|stars?)$/i.exec(t);
  if (m) return clampRating(Number(m[1]) * 2);
  m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*10)?$/.exec(t);
  if (m) return clampRating(Number(m[1]));
  return null;
}
const clampRating = (n: number) => (Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : null);

export interface CsvRow {
  /** 1-based line in the file, header included, for the owner to find it. */
  line: number;
  fields: StoreFields;
  progress: string | null;
  rating: number | null;
  note: string | null;
  key: string;
}

const COLUMNS = [
  'title',
  'author',
  'store',
  'kind',
  'progress',
  'isbn',
  'series',
  'series_index',
  'rating',
  'note',
];

export function rowsFromCsv(text: string): { rows: CsvRow[]; problems: string[] } {
  const all = parseCsv(text);
  if (all.length === 0) throw new HttpError(400, 'The file is empty.');
  const header = all[0]!.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  const col = (name: string) => header.indexOf(name);
  if (col('title') < 0)
    throw new HttpError(
      400,
      `The first line must name the columns, including “title”. Known columns: ${COLUMNS.join(', ')}.`,
    );
  const unknown = header.filter((h) => h && !COLUMNS.includes(h));
  const problems = unknown.length ? [`Columns not used: ${unknown.join(', ')}.`] : [];
  const rows: CsvRow[] = [];
  all.slice(1).forEach((r, i) => {
    const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
    const line = i + 2;
    if (!get('title')) {
      problems.push(`Line ${line}: no title, skipped.`);
      return;
    }
    let fields: StoreFields;
    try {
      fields = validateFields({
        title: get('title'),
        author: get('author'),
        store: storeFrom(get('store')),
        kind: get('kind'),
        isbn: get('isbn'),
        series: get('series'),
        number: get('series_index') || undefined,
      });
    } catch (e) {
      problems.push(`Line ${line}: ${(e as Error).message}`);
      return;
    }
    if (get('progress') && progressFrom(get('progress')) === null)
      problems.push(`Line ${line}: progress “${get('progress')}” not understood, left out.`);
    if (get('rating') && ratingFrom(get('rating')) === null)
      problems.push(`Line ${line}: rating “${get('rating')}” not understood, left out.`);
    rows.push({
      line,
      fields,
      progress: progressFrom(get('progress')),
      rating: ratingFrom(get('rating')),
      note: get('note') || null,
      key: rowKey(fields),
    });
  });
  if (rows.length > 20_000) throw new HttpError(400, 'That’s more than 20,000 rows.');
  return { rows, problems };
}

/** How a row is recognised next time (§14): its ISBN, else title + author + store. */
export function rowKey(f: Pick<StoreFields, 'isbn' | 'title' | 'author' | 'store'>): string {
  if (f.isbn) return `isbn:${f.isbn}`;
  const author = (f.author ?? '').toLowerCase().replace(/[^\p{L}]+/gu, '');
  return `t:${titleCompareKey(f.title)}|a:${author}|s:${f.store}`;
}

export interface PreviewRow {
  line: number;
  title: string;
  author: string | null;
  store: Store;
  /**
   * already: imported before (nothing new is made). isbn: the same ISBN is in the library —
   * the store is added to that book. possible: the same title and author — added there only if
   * the owner ticks it. new: a book of its own (unverified until a lookup finds it).
   */
  outcome: 'already' | 'isbn' | 'possible' | 'new';
  itemId: string | null;
  itemTitle: string | null;
  /** What the row would record on the book. */
  applies: string[];
  /** What the row says that differs from what the owner already has: the owner's is kept. */
  kept: string[];
}

function ownerChanges(
  db: DB,
  itemId: string | null,
  r: CsvRow,
): { applies: string[]; kept: string[]; patch: Record<string, unknown> } {
  const u = itemId
    ? (db.prepare('SELECT progress, rating, note FROM user_item WHERE item_id = ?').get(itemId) as
        { progress: string; rating: number | null; note: string | null } | undefined)
    : undefined;
  const applies: string[] = [];
  const kept: string[] = [];
  const patch: Record<string, unknown> = {};
  if (r.progress && r.progress !== 'not_started') {
    if (!u || u.progress === 'not_started') {
      applies.push(`progress ${r.progress.replace('_', ' ')}`);
      patch.progress = r.progress;
      // No dates in this file: a finish is recorded with its date unknown (§13.6).
      if (r.progress === 'finished') patch.finishedPrecision = 'unknown';
    } else if (u.progress !== r.progress)
      kept.push(
        `progress: the file says ${r.progress.replace('_', ' ')}, yours is ${u.progress.replace('_', ' ')}`,
      );
  }
  if (r.rating !== null) {
    if (!u || u.rating === null) {
      applies.push(`rating ${r.rating}/10`);
      patch.rating = r.rating;
    } else if (u.rating !== r.rating)
      kept.push(`rating: the file says ${r.rating}/10, yours is ${u.rating}/10`);
  }
  if (r.note) {
    if (!u || !u.note) {
      applies.push('note');
      patch.note = r.note;
    } else if (u.note !== r.note) kept.push('note: yours is kept');
  }
  return { applies, kept, patch };
}

function titleOfItem(db: DB, id: string): string {
  return (
    (db
      .prepare(
        'SELECT COALESCE(u.title_override, i.title) FROM items i LEFT JOIN user_item u ON u.item_id = i.id WHERE i.id = ?',
      )
      .pluck()
      .get(id) as string | undefined) ?? ''
  );
}

export function previewCsv(db: DB, text: string): { rows: PreviewRow[]; problems: string[] } {
  const { rows, problems } = rowsFromCsv(text);
  const seen = new Set<string>();
  const out: PreviewRow[] = [];
  const isbns = isbnIndex(db);
  const titles = titleIndex(db);
  for (const r of rows) {
    if (seen.has(r.key)) {
      problems.push(`Line ${r.line}: the same book as an earlier line, skipped.`);
      continue;
    }
    seen.add(r.key);
    const prior = db
      .prepare("SELECT item_id FROM import_keys WHERE source = 'store_csv' AND row_key = ?")
      .pluck()
      .get(r.key) as string | undefined;
    let outcome: PreviewRow['outcome'] = 'new';
    let itemId: string | null = null;
    if (prior) [outcome, itemId] = ['already', prior];
    else if (r.fields.isbn && isbns.get(r.fields.isbn)?.size === 1)
      [outcome, itemId] = ['isbn', [...isbns.get(r.fields.isbn)!][0]!];
    else {
      const same = itemsWithTitle(titles, r.fields.title, r.fields.author);
      if (same.length === 1) [outcome, itemId] = ['possible', same[0]!];
    }
    const { applies, kept } = ownerChanges(db, itemId, r);
    out.push({
      line: r.line,
      title: r.fields.title,
      author: r.fields.author ?? null,
      store: r.fields.store,
      outcome,
      itemId,
      itemTitle: itemId ? titleOfItem(db, itemId) : null,
      applies,
      kept,
    });
  }
  return { rows: out, problems };
}

/**
 * Imports the file as previewed. `attach` lists the lines whose possible match the owner ticked;
 * `keepNew` says whether rows matching nothing become books (unverified) or are skipped. Owner
 * data only fills what's empty: the owner's own edits always win.
 */
export function importCsv(
  db: DB,
  text: string,
  opts: { attach: number[]; keepNew: boolean },
): { added: number; attached: number; already: number; skipped: number } {
  return db.transaction(() => {
    const { rows } = rowsFromCsv(text);
    const preview = previewCsv(db, text).rows;
    const byLine = new Map(rows.map((r) => [r.line, r]));
    const counts = { added: 0, attached: 0, already: 0, skipped: 0 };
    const now = nowIso();
    for (const p of preview) {
      const r = byLine.get(p.line)!;
      let itemId: string | null;
      if (p.outcome === 'already') {
        itemId = p.itemId;
        counts.already++;
      } else if (
        p.outcome === 'isbn' ||
        (p.outcome === 'possible' && opts.attach.includes(p.line))
      ) {
        itemId = p.itemId!;
        addLocation(db, itemId, r.fields.store);
        counts.attached++;
      } else if (opts.keepNew) {
        itemId = createStoreItem(db, r.fields);
        counts.added++;
      } else {
        counts.skipped++;
        continue;
      }
      if (!itemId || !db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) continue;
      const { patch } = ownerChanges(db, itemId, r);
      if (Object.keys(patch).length) applyUserPatch(db, itemId, patch);
      db.prepare(
        'INSERT OR IGNORE INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
      ).run('store_csv', r.key, itemId, now);
    }
    syncSeries(db);
    return counts;
  })();
}

/** Removes a book that has no files (a store title or an entry read elsewhere). */
export function removeFilelessItem(db: DB, itemId: string): void {
  if (db.prepare('SELECT 1 FROM item_files WHERE item_id = ?').get(itemId))
    throw new HttpError(409, 'This book has files; it can’t be removed here.');
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
  db.prepare(
    'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
  ).run('item', itemId, nowIso());
  syncSeries(db);
}
