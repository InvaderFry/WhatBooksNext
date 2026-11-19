-- The owner's splits, kept apart from the bounded undo history (operations keeps only the last
-- 20, and a restore clears it). Automatic regrouping (identify/reconcile.ts,
-- regroupAudiobookParts) never joins files the owner split apart. Undoing the split removes it.
CREATE TABLE owner_splits (
  id TEXT PRIMARY KEY,
  operation_id TEXT,                 -- the undo entry that made it, while it exists
  kept_file_ids TEXT NOT NULL,       -- JSON: files that stayed in the original item
  moved_file_ids TEXT NOT NULL,      -- JSON: files split off into the new item
  created_at TEXT NOT NULL
);
CREATE INDEX owner_splits_operation ON owner_splits (operation_id);
