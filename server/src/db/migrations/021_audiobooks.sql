-- Audiobooks (docs/plans/audiobooks.md).

-- Where a library folder holds audiobooks: a JSON list of directories below the folder
-- ('' is the whole folder). Audio files count as books only inside these, so music elsewhere is
-- never picked up (owner decision 2026-11-17). folders is backed up whole; the default keeps
-- older backups restorable.
ALTER TABLE folders ADD COLUMN audiobook_dirs TEXT NOT NULL DEFAULT '[]';

-- For an audio file: the directory (below the folder) of the book it is a part of. A book's
-- parts share this and compare_key, across "CD 1" / "CD 2" subfolders. NULL for other files.
ALTER TABLE files ADD COLUMN book_dir TEXT;

-- An audio file's playing time, read from the file. NULL: not read yet, or it doesn't say.
ALTER TABLE files ADD COLUMN duration_seconds REAL;

-- Audible joins the stores. SQLite can't change a CHECK in place, so both tables are rebuilt
-- with the same columns in the same order. Nothing references either table.
CREATE TABLE locations_new (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('store', 'history')),
  store TEXT CHECK (store IN ('kindle', 'kobo', 'globalcomix', 'apple_books', 'google_play', 'audible', 'other')),
  confirmed_readable INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_readable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  url TEXT,
  url_kind TEXT CHECK (url_kind IN ('read', 'page')),
  url_by_owner INTEGER NOT NULL DEFAULT 0 CHECK (url_by_owner IN (0, 1))
);
INSERT INTO locations_new SELECT id, item_id, kind, store, confirmed_readable, note, created_at,
  updated_at, url, url_kind, url_by_owner FROM locations;
DROP TABLE locations;
ALTER TABLE locations_new RENAME TO locations;

CREATE TABLE store_purchases_new (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('kindle', 'google_play', 'kobo', 'globalcomix', 'audible')),
  account_scope TEXT NOT NULL DEFAULT 'default',
  store_record_id TEXT NOT NULL,
  id_kind TEXT NOT NULL,
  unit TEXT CHECK (unit IN ('issue', 'volume', 'collection', 'book')),
  acquisition TEXT NOT NULL CHECK (acquisition IN ('purchase', 'free_claim', 'uncertain')),
  acquired_at TEXT,
  acquired_precision TEXT CHECK (acquired_precision IN ('day', 'month', 'year')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_complete_scan_at TEXT,
  adapter_version TEXT NOT NULL,
  not_seen_since TEXT,
  not_seen_kept INTEGER NOT NULL DEFAULT 0 CHECK (not_seen_kept IN (0, 1)),
  UNIQUE (service, account_scope, id_kind, store_record_id)
);
INSERT INTO store_purchases_new SELECT id, item_id, service, account_scope, store_record_id,
  id_kind, unit, acquisition, acquired_at, acquired_precision, first_seen_at, last_seen_at,
  last_complete_scan_at, adapter_version, not_seen_since, not_seen_kept FROM store_purchases;
DROP TABLE store_purchases;
ALTER TABLE store_purchases_new RENAME TO store_purchases;
CREATE INDEX store_purchases_item ON store_purchases(item_id);

-- A listening length the owner or a store states for a store audiobook, in minutes (Audible's
-- runtime). NULL: unknown. Never guessed.
ALTER TABLE locations ADD COLUMN listen_minutes INTEGER;
