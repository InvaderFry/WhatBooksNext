-- Milestone 2: the deep pass. PLAN.md §9.2, §10, §11.3, §11.4, §9.7.
-- Every new column is nullable or has a default, so a version-1 backup still restores.

-- What the file's contents say (facts, never owner data).
ALTER TABLE files ADD COLUMN metadata TEXT;          -- JSON: embedded metadata (§10)
ALTER TABLE files ADD COLUMN pdf_type TEXT
  CHECK (pdf_type IN ('comic', 'text', 'scanned', 'uncertain'));
ALTER TABLE files ADD COLUMN pdf_type_evidence TEXT;  -- plain-language evidence shown with the type
ALTER TABLE files ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK (has_thumbnail IN (0, 1));
-- Library health (§15): why the deep pass couldn't read the file. Cleared when a read succeeds.
ALTER TABLE files ADD COLUMN problem TEXT
  CHECK (problem IN ('corrupt', 'limit', 'timeout', 'not_comic', 'too_large', 'encrypted'));
ALTER TABLE files ADD COLUMN problem_detail TEXT;
ALTER TABLE files ADD COLUMN problem_at TEXT;
-- A .zip/.rar that isn't a comic (§9.1): kept on record, dropped from the library.
ALTER TABLE files ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));
CREATE INDEX files_full_hash ON files (full_hash) WHERE full_hash IS NOT NULL;

-- Where an item's title came from: 'filename' or 'embedded' (the file's own metadata).
ALTER TABLE items ADD COLUMN title_source TEXT;

-- Scan reminder (§9.7): "Dismiss" snoozes a folder's banner until this time.
ALTER TABLE folders ADD COLUMN reminder_snoozed_until TEXT;

-- Owner corrections on a single file (§11.4 "Fix PDF type"). Kept apart from the facts (§6.5).
CREATE TABLE file_user (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  pdf_type_override TEXT CHECK (pdf_type_override IN ('comic', 'text', 'scanned')),
  updated_at TEXT NOT NULL
);

-- Needs review (§11.4). M2 adds what the deep pass finds; M3 adds tiers' other rows, Defer
-- and Dismiss. `key` identifies the question, so a later scan never asks it twice and a
-- declined suggestion stays declined.
CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'group_conflict', 'copy_conflict', 'cross_folder')),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  key TEXT NOT NULL UNIQUE,
  item_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array
  file_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array
  detail TEXT NOT NULL DEFAULT '{}',     -- JSON: what was found, for the review row
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'obsolete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX review_items_open ON review_items (status, tier);
