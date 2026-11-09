-- Milestone 1 schema. PLAN.md §7.
-- Facts from files and sources are kept apart from what the owner enters (§6.5):
-- folders/files/items hold facts; user_item, locations and shortlist hold owner data.
-- Every owner edit has updated_at. Item ids are UUIDs that never change.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  display_path TEXT NOT NULL,       -- as the owner added it
  volume_id TEXT,                   -- e.g. \\?\Volume{...}\ ; null where the platform has none
  volume_serial TEXT,
  volume_label TEXT,
  relative_path TEXT NOT NULL,      -- path below the volume root
  last_letter TEXT,                 -- last drive letter it was found on, e.g. 'E'
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('local', 'external', 'cloud')),
  also_in_icloud INTEGER NOT NULL DEFAULT 0 CHECK (also_in_icloud IN (0, 1)),
  last_seen_at TEXT,
  last_complete_scan_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- When each directory was last COMPLETELY listed. Drives the missing-file rule (§9.3).
CREATE TABLE directory_scans (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  rel_dir TEXT NOT NULL,            -- '' for the folder itself, '/'-separated below it
  listed_at TEXT NOT NULL,
  PRIMARY KEY (folder_id, rel_dir)
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,           -- '/'-separated, below the folder
  rel_dir TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,                -- lowercase, no dot
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_ms INTEGER,
  modified_ms INTEGER,
  partial_hash TEXT,
  full_hash TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('present', 'placeholder', 'unknown', 'missing')),
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  attributes INTEGER,               -- raw Windows attribute bits, when read
  stages TEXT NOT NULL DEFAULT '{}',-- JSON: stage name -> version completed
  parsed TEXT NOT NULL DEFAULT '{}',-- JSON: filename parser output (§11.1)
  compare_key TEXT NOT NULL,        -- base name for same-folder format grouping (§11.3 rule 2)
  language TEXT,
  abridged INTEGER,
  edition_number INTEGER,
  quality_tag TEXT,
  edition_note TEXT,
  word_count INTEGER,
  page_count INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (folder_id, rel_path)
);
CREATE INDEX files_name_size ON files (name COLLATE NOCASE, size);
CREATE INDEX files_dir ON files (folder_id, rel_dir, compare_key);

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT,
  publication_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (publication_status IN ('finished', 'ongoing', 'unknown')),
  installments INTEGER,
  source_ids TEXT NOT NULL DEFAULT '{}',
  order_source TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT CHECK (kind IN ('fiction', 'nonfiction', 'self_help', 'tech', 'comic', 'manga')),
  kind_source TEXT,                 -- 'filename', 'format', 'source:...'; null when unknown
  is_reference INTEGER NOT NULL DEFAULT 0 CHECK (is_reference IN (0, 1)),
  title TEXT NOT NULL,
  creators TEXT NOT NULL DEFAULT '[]',
  series_id TEXT REFERENCES series(id) ON DELETE SET NULL,
  series_position REAL,
  series_hint TEXT,                 -- series name guessed from the filename (low confidence)
  volume_label TEXT,                -- '1', '1.5' ... as parsed
  issue_label TEXT,
  publication_year INTEGER,
  identifiers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_files (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (item_id, file_id)
);

-- Places an item can be read other than its files: stores and reading history (§7).
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('store', 'history')),
  store TEXT CHECK (store IN ('kindle', 'kobo', 'globalcomix', 'apple_books', 'google_play', 'other')),
  confirmed_readable INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_readable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_item (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  progress TEXT NOT NULL DEFAULT 'not_started' CHECK (progress IN
    ('not_started', 'sampled', 'into_it', 'halfway', 'nearly_done', 'finished', 'dnf')),
  dnf_reason TEXT CHECK (dnf_reason IN ('not_for_me', 'not_now', 'too_difficult')),
  started_on TEXT,
  started_precision TEXT CHECK (started_precision IN ('exact', 'approximate', 'unknown')),
  finished_on TEXT,
  finished_precision TEXT CHECK (finished_precision IN ('exact', 'approximate', 'unknown')),
  progress_at TEXT,                 -- when progress last changed (for "last touched")
  triage TEXT CHECK (triage IN ('want', 'maybe', 'never')),
  triage_at TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 10),
  note TEXT,
  takeaway TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  shortlist_position INTEGER,
  title_override TEXT,
  kind_override TEXT CHECK (kind_override IN ('fiction', 'nonfiction', 'self_help', 'tech', 'comic', 'manga')),
  reference_override INTEGER CHECK (reference_override IN (0, 1)),
  effort_override TEXT CHECK (effort_override IN ('light', 'medium', 'heavy')),
  icloud_override TEXT CHECK (icloud_override IN ('in', 'not_in')),
  acquired_on TEXT,
  acquired_precision TEXT CHECK (acquired_precision IN ('exact', 'approximate', 'unknown')),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX user_item_shortlist ON user_item (shortlist_position)
  WHERE shortlist_position IS NOT NULL;

-- Retired item id -> surviving id (§6.5).
CREATE TABLE id_aliases (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Deleted records, kept for a future sync (§6.5).
CREATE TABLE deletions (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id)
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT NOT NULL DEFAULT '{}'
);
