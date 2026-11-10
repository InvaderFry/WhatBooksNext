import Database from 'better-sqlite3';
import path from 'node:path';

/**
 * Builds a small Calibre library (metadata.db) for tests, with the table shapes of Calibre's
 * own schema (resources/metadata_sqlite.sql, user_version 28) and custom columns as Calibre's
 * custom_columns.py creates them. Only invented books.
 */

export interface FakeCalibreBook {
  title: string;
  authors: string[];
  /** Calibre's folder for the book, relative to the library ("Author/Title (1)"). */
  path: string;
  formats: { format: string; name: string }[];
  series?: string;
  seriesIndex?: number;
  isbn?: string;
  tags?: string[];
  /** 0–10 as Calibre stores it. */
  rating?: number;
  read?: boolean;
  readOn?: string;
}

export function makeCalibreDb(dir: string, books: FakeCalibreBook[]): string {
  const file = path.join(dir, 'metadata.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT 'Unknown',
      sort TEXT, timestamp TIMESTAMP, pubdate TIMESTAMP, series_index REAL NOT NULL DEFAULT 1.0,
      author_sort TEXT, path TEXT NOT NULL DEFAULT '', uuid TEXT, has_cover BOOL DEFAULT 0,
      last_modified TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:00+00:00');
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT, link TEXT NOT NULL DEFAULT '', UNIQUE(name));
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT, link TEXT NOT NULL DEFAULT '', UNIQUE (name));
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
    CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER CHECK(rating > -1 AND rating < 11), link TEXT NOT NULL DEFAULT '', UNIQUE (rating));
    CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT '', UNIQUE (name));
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
    CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT, link TEXT NOT NULL DEFAULT '', UNIQUE(name));
    CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book));
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL COLLATE NOCASE, UNIQUE(book));
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(book, format));
    CREATE TABLE library_id (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, UNIQUE(uuid));
    CREATE TABLE custom_columns (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, name TEXT NOT NULL,
      datatype TEXT NOT NULL, mark_for_delete BOOL DEFAULT 0 NOT NULL, editable BOOL DEFAULT 1 NOT NULL,
      display TEXT DEFAULT '{}' NOT NULL, is_multiple BOOL DEFAULT 0 NOT NULL, normalized BOOL NOT NULL, UNIQUE(label));
    CREATE TABLE custom_column_1 (id INTEGER PRIMARY KEY AUTOINCREMENT, book INTEGER, value BOOL NOT NULL, UNIQUE(book));
    CREATE TABLE custom_column_2 (id INTEGER PRIMARY KEY AUTOINCREMENT, book INTEGER, value timestamp NOT NULL, UNIQUE(book));
    INSERT INTO library_id (uuid) VALUES ('11111111-2222-3333-4444-555555555555');
    INSERT INTO custom_columns (id, label, name, datatype, normalized) VALUES
      (1, 'read', 'Read', 'bool', 0), (2, 'date_read', 'Date read', 'datetime', 0);
  `);
  const one = (table: string, name: string) => {
    db.prepare(`INSERT OR IGNORE INTO ${table} (name) VALUES (?)`).run(name);
    return db.prepare(`SELECT id FROM ${table} WHERE name = ?`).pluck().get(name) as number;
  };
  books.forEach((b, i) => {
    const id = i + 1;
    db.prepare(
      'INSERT INTO books (id, title, path, series_index, uuid) VALUES (?, ?, ?, ?, ?)',
    ).run(id, b.title, b.path, b.seriesIndex ?? 1, `uuid-${id}`);
    for (const a of b.authors)
      db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(
        id,
        one('authors', a),
      );
    if (b.series)
      db.prepare('INSERT INTO books_series_link (book, series) VALUES (?, ?)').run(
        id,
        one('series', b.series),
      );
    if (b.isbn)
      db.prepare("INSERT INTO identifiers (book, type, val) VALUES (?, 'isbn', ?)").run(id, b.isbn);
    for (const t of b.tags ?? [])
      db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(id, one('tags', t));
    if (b.rating !== undefined) {
      db.prepare('INSERT OR IGNORE INTO ratings (rating) VALUES (?)').run(b.rating);
      const r = db.prepare('SELECT id FROM ratings WHERE rating = ?').pluck().get(b.rating);
      db.prepare('INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)').run(id, r);
    }
    for (const f of b.formats)
      db.prepare(
        'INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, 1000, ?)',
      ).run(id, f.format, f.name);
    if (b.read !== undefined)
      db.prepare('INSERT INTO custom_column_1 (book, value) VALUES (?, ?)').run(id, b.read ? 1 : 0);
    if (b.readOn)
      db.prepare('INSERT INTO custom_column_2 (book, value) VALUES (?, ?)').run(
        id,
        `${b.readOn}T12:00:00+00:00`,
      );
  });
  db.close();
  return file;
}
