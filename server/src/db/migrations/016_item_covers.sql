-- Covers for books without a file cover (store books, reading history), fetched from Open Library
-- once a book is matched there with confidence (owner decision 2026-11-11). The picture is kept in
-- the data folder's covers/ as item-<item id>.jpg, like file covers. Left out of backups, like the
-- covers themselves: it is fetched again when missing.
CREATE TABLE item_covers (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  -- ok: the picture is saved. none: the source has no cover for this book (asked again later).
  -- failed: the answer couldn't be used (asked again later).
  state TEXT NOT NULL CHECK (state IN ('ok', 'none', 'failed')),
  source TEXT NOT NULL,
  -- The source's record the cover belongs to (an Open Library work key), and its cover ID.
  source_ref TEXT NOT NULL,
  cover_id TEXT,
  checked_at TEXT NOT NULL
);
