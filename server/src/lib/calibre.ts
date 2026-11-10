import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { applyIdentity } from '../identify/lookups.ts';
import { samePerson } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import { availabilityFromAttributes, type Platform } from '../platform/types.ts';
import { resolveFolderRoot, type FolderRow } from '../scan/folders.ts';
import type { SourceRecord } from '../sources/types.ts';
import { HttpError, nowIso, parseJson } from '../util.ts';
import { applyUserPatch } from './progress.ts';
import { createStoreItem, isbnIndex, normIsbn } from './store.ts';

/**
 * Calibre import (PLAN.md §14), modest and read-only.
 *
 *  - `metadata.db` is copied into the app's data folder and only the copy is read: Calibre is
 *    never written to, locked or disturbed. The copy is taken only after a fresh attribute
 *    check says the file is really on disk (§9.5).
 *  - Facts (title, authors, series and index, identifiers, publisher, tags, description) are
 *    kept as a match from the source "Calibre": strong evidence, shown as Calibre's, and never
 *    over the owner's corrections. Kept as a match, a later scan can't overwrite them.
 *  - The owner's data comes across only if chosen: Calibre's rating (0–10, 0 = unrated), and a
 *    "read" custom column with an optional date column. Owner data only fills what's empty.
 *  - Books are matched to scanned files by path (when the Calibre library is in a scanned
 *    folder), then by ISBN with the title or an author agreeing. Others can be kept as
 *    unconfirmed books, or skipped. Repeatable: a book is recognised by Calibre's own uuid.
 *
 * Checked against Calibre's source (November 2026): resources/metadata_sqlite.sql (schema
 * user_version 28) and src/calibre/library/custom_columns.py. Its views (meta, tag_browser_*)
 * call functions only Calibre defines, so only plain tables are read here.
 */

export interface CalibreBook {
  id: number;
  uuid: string;
  title: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  isbns: string[];
  identifiers: Record<string, string>;
  tags: string[];
  publisher: string | null;
  comments: string | null;
  /** 0–10 as Calibre stores it; null when unrated (0 is "unrated", never 1). */
  rating: number | null;
  path: string;
  formats: { format: string; name: string }[];
  /** Values of the custom columns that can say "read" or give a date, by column label. */
  custom: Record<string, string | number | null>;
}

export interface CalibreColumn {
  label: string;
  name: string;
  datatype: string;
}

export interface CalibreLibrary {
  libraryId: string;
  books: CalibreBook[];
  /** Custom columns that can hold "read" (bool, text, enumeration) or a date (datetime). */
  columns: CalibreColumn[];
}

const tableExists = (c: Database.Database, name: string) =>
  Boolean(c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Reads a copy of metadata.db into memory. */
export function readCalibreDb(file: string): CalibreLibrary {
  const c = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(c, 'books') || !tableExists(c, 'data'))
      throw new HttpError(400, 'That metadata.db doesn’t look like a Calibre library.');
    const libraryId =
      (tableExists(c, 'library_id')
        ? (c.prepare('SELECT uuid FROM library_id LIMIT 1').pluck().get() as string | undefined)
        : undefined) ?? 'library';
    const many = (sql: string) => {
      const out = new Map<number, string[]>();
      for (const r of c.prepare(sql).all() as { book: number; v: string }[]) {
        if (!out.has(r.book)) out.set(r.book, []);
        out.get(r.book)!.push(r.v);
      }
      return out;
    };
    const authors = many(
      'SELECT l.book, a.name AS v FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id',
    );
    const series = many(
      'SELECT l.book, s.name AS v FROM books_series_link l JOIN series s ON s.id = l.series',
    );
    const tags = many(
      'SELECT l.book, t.name AS v FROM books_tags_link l JOIN tags t ON t.id = l.tag',
    );
    const publishers = many(
      'SELECT l.book, p.name AS v FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher',
    );
    const comments = many('SELECT book, text AS v FROM comments');
    const ratings = new Map(
      (
        c
          .prepare(
            'SELECT l.book, r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating',
          )
          .all() as { book: number; rating: number }[]
      ).map((r) => [r.book, r.rating]),
    );
    const idents = new Map<number, Record<string, string>>();
    for (const r of c.prepare('SELECT book, type, val FROM identifiers').all() as {
      book: number;
      type: string;
      val: string;
    }[]) {
      if (!idents.has(r.book)) idents.set(r.book, {});
      idents.get(r.book)![r.type.toLowerCase()] = r.val;
    }
    const formats = new Map<number, { format: string; name: string }[]>();
    for (const r of c.prepare('SELECT book, format, name FROM data').all() as {
      book: number;
      format: string;
      name: string;
    }[]) {
      if (!formats.has(r.book)) formats.set(r.book, []);
      formats.get(r.book)!.push({ format: r.format, name: r.name });
    }

    // Custom columns that can say whether a book was read, or when.
    const columns: (CalibreColumn & { id: number; normalized: number })[] = tableExists(
      c,
      'custom_columns',
    )
      ? (c
          .prepare(
            `SELECT id, label, name, datatype, normalized FROM custom_columns
             WHERE mark_for_delete = 0 AND is_multiple = 0
               AND datatype IN ('bool', 'text', 'enumeration', 'datetime')`,
          )
          .all() as (CalibreColumn & { id: number; normalized: number })[])
      : [];
    const custom = new Map<number, Record<string, string | number | null>>();
    for (const col of columns) {
      const t = `custom_column_${col.id}`;
      if (!tableExists(c, t)) continue;
      const rows = col.normalized
        ? tableExists(c, `books_${t}_link`)
          ? (c
              .prepare(
                `SELECT l.book, v.value FROM books_${t}_link l JOIN ${t} v ON v.id = l.value`,
              )
              .all() as { book: number; value: string | number }[])
          : []
        : (c.prepare(`SELECT book, value FROM ${t}`).all() as {
            book: number;
            value: string | number;
          }[]);
      for (const r of rows) {
        if (!custom.has(r.book)) custom.set(r.book, {});
        custom.get(r.book)![col.label] = r.value;
      }
    }

    const books = (
      c.prepare('SELECT id, uuid, title, path, series_index FROM books').all() as {
        id: number;
        uuid: string | null;
        title: string;
        path: string;
        series_index: number | null;
      }[]
    ).map((b): CalibreBook => {
      const ids = idents.get(b.id) ?? {};
      const s = series.get(b.id)?.[0] ?? null;
      const r = ratings.get(b.id);
      return {
        id: b.id,
        uuid: b.uuid ?? `id:${b.id}`,
        title: b.title,
        authors: authors.get(b.id) ?? [],
        series: s,
        seriesIndex: s && typeof b.series_index === 'number' ? b.series_index : null,
        isbns: [ids.isbn, ids.isbn13, ids.isbn10]
          .map((x) => normIsbn(x))
          .filter((x): x is string => x !== null),
        identifiers: ids,
        tags: tags.get(b.id) ?? [],
        publisher: publishers.get(b.id)?.[0] ?? null,
        comments: comments.get(b.id)?.[0] ?? null,
        rating: typeof r === 'number' && r > 0 && r <= 10 ? r : null,
        path: b.path,
        formats: formats.get(b.id) ?? [],
        custom: custom.get(b.id) ?? {},
      };
    });
    return {
      libraryId,
      books,
      columns: columns.map(({ label, name, datatype }) => ({ label, name, datatype })),
    };
  } finally {
    c.close();
  }
}

/** Copies metadata.db (and a WAL file beside it, if any) somewhere the app owns, then reads it. */
export async function copyAndRead(
  platform: Platform,
  libraryPath: string,
  dataDir: string | null,
): Promise<CalibreLibrary> {
  const src = path.join(libraryPath, 'metadata.db');
  if (!fs.existsSync(src))
    throw new HttpError(
      400,
      'There’s no metadata.db in that folder. Choose the folder Calibre calls its library.',
    );
  if (platform.supportsPlaceholders) {
    const state = availabilityFromAttributes(await platform.checkAttributes(src));
    if (state !== 'present')
      throw new HttpError(
        409,
        state === 'placeholder'
          ? 'That metadata.db is online-only. Download it first (or open Calibre once), then try again.'
          : 'Couldn’t check that metadata.db is on this PC, so it wasn’t read.',
      );
  }
  const dir = dataDir
    ? path.join(dataDir, 'calibre')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'wbn-calibre-'));
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, 'metadata.db');
  for (const ext of ['', '-wal']) {
    fs.rmSync(copy + ext, { force: true });
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
  }
  try {
    return readCalibreDb(copy);
  } finally {
    if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface CalibreOptions {
  /** Bring Calibre's ratings across. */
  ratings: boolean;
  /** A custom column saying a book was read (yes/true, or text like "read"). */
  readColumn: string | null;
  /** A custom date column giving when it was read. */
  dateColumn: string | null;
  /** Keep books with no files in the library as unconfirmed books (else skip them). */
  keepUnmatched: boolean;
}

export interface CalibrePreviewRow {
  title: string;
  authors: string[];
  outcome: 'already' | 'files' | 'isbn' | 'none';
  itemId: string | null;
  applies: string[];
  kept: string[];
}

export interface CalibrePreview {
  books: number;
  counts: Record<CalibrePreviewRow['outcome'], number>;
  columns: CalibreColumn[];
  /** Is the Calibre library inside a scanned folder (so files can be matched by path)? */
  inScannedFolder: boolean;
  rows: CalibrePreviewRow[];
}

const READ_WORDS = /^(true|1|yes|y|read|finished|done|completed)$/i;

function readValue(b: CalibreBook, opts: CalibreOptions): { read: boolean; date: string | null } {
  const v = opts.readColumn ? b.custom[opts.readColumn] : undefined;
  const read = v !== undefined && v !== null && READ_WORDS.test(String(v).trim());
  const d = opts.dateColumn ? b.custom[opts.dateColumn] : undefined;
  // Calibre's "undefined date" is year 101; anything before 1900 isn't a real date.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  const date = m && Number(m[1]) >= 1900 ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return { read, date };
}

function ownerChanges(db: DB, itemId: string | null, b: CalibreBook, opts: CalibreOptions) {
  const u = itemId
    ? (db.prepare('SELECT progress, rating FROM user_item WHERE item_id = ?').get(itemId) as
        { progress: string; rating: number | null } | undefined)
    : undefined;
  const applies: string[] = [];
  const kept: string[] = [];
  const patch: Record<string, unknown> = {};
  if (opts.ratings && b.rating !== null) {
    if (!u || u.rating === null) {
      applies.push(`rating ${b.rating}/10`);
      patch.rating = b.rating;
    } else if (u.rating !== b.rating)
      kept.push(`rating: Calibre has ${b.rating}/10, yours is ${u.rating}/10`);
  }
  const { read, date } = readValue(b, opts);
  if (read) {
    if (!u || u.progress === 'not_started') {
      applies.push(date ? `read on ${date}` : 'read (date unknown)');
      patch.progress = 'finished';
      if (date) [patch.finishedOn, patch.finishedPrecision] = [date, 'exact'];
      else patch.finishedPrecision = 'unknown';
    } else if (u.progress !== 'finished')
      kept.push(`progress: Calibre says read, yours is ${u.progress.replace('_', ' ')}`);
  }
  return { applies, kept, patch };
}

/** Calibre's facts as a source record (§14): shown as Calibre's, strong evidence. */
function recordOf(b: CalibreBook): SourceRecord {
  return {
    source: 'calibre',
    sourceId: b.uuid,
    title: b.title,
    authors: b.authors,
    isbns: b.isbns,
    subjects: b.tags,
    ...(b.series
      ? {
          series: {
            name: b.series,
            ...(b.seriesIndex !== null ? { position: b.seriesIndex } : {}),
            status: 'unknown' as const,
          },
        }
      : {}),
    ...(b.comments ? { description: b.comments } : {}),
  };
}

interface Matcher {
  byPath: (b: CalibreBook) => string | null;
  inScannedFolder: boolean;
}

/** Files of the Calibre library that a scan found, by path (when it's in a scanned folder). */
async function pathMatcher(db: DB, platform: Platform, libraryPath: string): Promise<Matcher> {
  const norm = (p: string) =>
    path
      .resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  const lib = norm(libraryPath);
  for (const f of db.prepare('SELECT * FROM folders').all() as FolderRow[]) {
    const root = await resolveFolderRoot(db, platform, f);
    if (!root) continue;
    const r = norm(root);
    if (lib !== r && !lib.startsWith(r + path.sep.toLowerCase()) && !lib.startsWith(r + '/'))
      continue;
    const prefix = path
      .relative(root, libraryPath)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/');
    const itemByRel = new Map<string, string>();
    for (const x of db
      .prepare(
        `SELECT f.rel_path, i.item_id FROM files f JOIN item_files i ON i.file_id = f.id
         WHERE f.folder_id = ? AND f.excluded = 0`,
      )
      .all(f.id) as { rel_path: string; item_id: string }[])
      itemByRel.set(x.rel_path.toLowerCase(), x.item_id);
    return {
      inScannedFolder: true,
      byPath: (b) => {
        for (const fm of b.formats) {
          const rel = [prefix, b.path, `${fm.name}.${fm.format.toLowerCase()}`]
            .filter(Boolean)
            .join('/');
          const id = itemByRel.get(rel.toLowerCase());
          if (id) return id;
        }
        return null;
      },
    };
  }
  return { inScannedFolder: false, byPath: () => null };
}

const key = (libraryId: string, b: CalibreBook) => `${libraryId}:${b.uuid}`;

async function plan(
  db: DB,
  platform: Platform,
  libraryPath: string,
  lib: CalibreLibrary,
  opts: CalibreOptions,
) {
  const m = await pathMatcher(db, platform, libraryPath);
  const isbns = isbnIndex(db);
  const facts = new Map(
    (
      db
        .prepare(
          `SELECT i.id, COALESCE(u.title_override, i.title) AS title, i.creators FROM items i
           LEFT JOIN user_item u ON u.item_id = i.id`,
        )
        .all() as { id: string; title: string; creators: string }[]
    ).map((r) => [r.id, r]),
  );
  return lib.books.map((b) => {
    let outcome: CalibrePreviewRow['outcome'] = 'none';
    let itemId: string | null = null;
    const prior = db
      .prepare("SELECT item_id FROM import_keys WHERE source = 'calibre' AND row_key = ?")
      .pluck()
      .get(key(lib.libraryId, b)) as string | undefined;
    if (prior) [outcome, itemId] = ['already', prior];
    else {
      const byPath = m.byPath(b);
      if (byPath) [outcome, itemId] = ['files', byPath];
      else
        for (const isbn of b.isbns) {
          const hits = [...(isbns.get(isbn) ?? [])];
          if (hits.length !== 1) continue;
          // An ISBN alone can be another edition's: the title or an author must agree too.
          const f = facts.get(hits[0]!);
          const names = parseJson<{ name: string }[]>(f?.creators ?? '[]', []).map((c) => c.name);
          if (
            f &&
            (titleCompareKey(f.title) === titleCompareKey(b.title) ||
              names.some((n) => b.authors.some((a) => samePerson(n, a))))
          ) {
            [outcome, itemId] = ['isbn', hits[0]!];
            break;
          }
        }
    }
    const { applies, kept, patch } = ownerChanges(db, itemId, b, opts);
    return { book: b, outcome, itemId, applies, kept, patch };
  });
}

export async function previewCalibre(
  db: DB,
  platform: Platform,
  libraryPath: string,
  dataDir: string | null,
  opts: CalibreOptions,
): Promise<CalibrePreview> {
  const lib = await copyAndRead(platform, libraryPath, dataDir);
  const rows = await plan(db, platform, libraryPath, lib, opts);
  const counts = { already: 0, files: 0, isbn: 0, none: 0 };
  for (const r of rows) counts[r.outcome]++;
  return {
    books: rows.length,
    counts,
    columns: lib.columns,
    inScannedFolder: (await pathMatcher(db, platform, libraryPath)).inScannedFolder,
    rows: rows.slice(0, 300).map((r) => ({
      title: r.book.title,
      authors: r.book.authors,
      outcome: r.outcome,
      itemId: r.itemId,
      applies: r.applies,
      kept: r.kept,
    })),
  };
}

export async function importCalibre(
  db: DB,
  platform: Platform,
  libraryPath: string,
  dataDir: string | null,
  opts: CalibreOptions,
): Promise<{ matched: number; added: number; skipped: number; already: number }> {
  const lib = await copyAndRead(platform, libraryPath, dataDir);
  const rows = await plan(db, platform, libraryPath, lib, opts);
  return db.transaction(() => {
    const counts = { matched: 0, added: 0, skipped: 0, already: 0 };
    const now = nowIso();
    const saveMatch = db.prepare(
      `INSERT OR REPLACE INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
       VALUES (?, 'calibre', ?, 1, 1, ?, ?, ?)`,
    );
    for (const r of rows) {
      let itemId = r.itemId;
      if (itemId && !db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) itemId = null;
      if (r.outcome === 'already' && itemId) counts.already++;
      else if (itemId) counts.matched++;
      else if (opts.keepUnmatched) {
        itemId = createStoreItem(db, {
          title: r.book.title,
          author: r.book.authors[0] ?? null,
          isbn: r.book.isbns[0] ?? null,
          series: r.book.series,
          number: r.book.seriesIndex !== null ? String(r.book.seriesIndex) : null,
          store: 'other',
        });
        db.prepare("UPDATE locations SET note = 'In Calibre' WHERE item_id = ?").run(itemId);
        counts.added++;
      } else {
        counts.skipped++;
        continue;
      }
      // Calibre's facts, as a match the owner can see (and reject) like any source's.
      const rejected = db
        .prepare(
          "SELECT 1 FROM candidates_rejected WHERE item_id = ? AND source = 'calibre' AND source_id = ?",
        )
        .get(itemId, r.book.uuid);
      if (!rejected) {
        db.prepare("DELETE FROM item_matches WHERE item_id = ? AND source = 'calibre'").run(itemId);
        saveMatch.run(
          itemId,
          r.book.uuid,
          JSON.stringify({
            title: 1,
            author: 'agrees',
            isbn: r.book.isbns.length ? 'strong' : 'none',
            notes: [
              r.outcome === 'files'
                ? 'The same file, in your Calibre library.'
                : 'From your Calibre library.',
            ],
          }),
          JSON.stringify(recordOf(r.book)),
          now,
        );
      }
      // ISBNs Calibre knows help the online lookups too.
      if (r.book.isbns.length) {
        const ids = parseJson<{ isbn?: string[] }>(
          db.prepare('SELECT identifiers FROM items WHERE id = ?').pluck().get(itemId) as string,
          {},
        );
        const all = [...new Set([...(ids.isbn ?? []), ...r.book.isbns])];
        db.prepare('UPDATE items SET identifiers = ? WHERE id = ?').run(
          JSON.stringify({ ...ids, isbn: all }),
          itemId,
        );
      }
      applyIdentity(db, itemId);
      const { patch } = ownerChanges(db, itemId, r.book, opts);
      if (Object.keys(patch).length) applyUserPatch(db, itemId, patch);
      db.prepare(
        'INSERT OR IGNORE INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
      ).run('calibre', key(lib.libraryId, r.book), itemId, now);
    }
    syncSeries(db);
    return counts;
  })();
}
