-- Published primary volumes are separate from the eventual length of a finished story.
-- Source facts only: these rows never create library items or ownership.
CREATE TABLE series_publications (
  series_id TEXT PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_series_id TEXT NOT NULL,
  anchor_book_id TEXT NOT NULL,
  anchor_key TEXT NOT NULL,
  entries TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
