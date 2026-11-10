-- Published-volume checks that failed for a reason retrying won't fix ("couldn't confidently
-- identify this series"). Remembered so every lookup run doesn't ask Hardcover again and list
-- the same problem: the series is checked again once its anchor book or number changes, or
-- after the catalogue refresh interval (7 days). A failed check never hides a good catalogue.
CREATE TABLE series_publication_problems (
  series_id TEXT PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
  anchor_book_id TEXT NOT NULL,
  anchor_key TEXT NOT NULL,
  problem TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
