-- Milestone 3: lookups, matching and recommendations. PLAN.md §7, §11.2, §11.4, §12, §13.
-- Every new column is nullable or has a default, so version-1 and version-2 backups restore.

-- Raw responses from online sources (§7). Item fields are re-derived from here when the
-- matching logic changes, without re-fetching from rate-limited APIs. Not in the backup: it
-- can be fetched again, and it would make backups large.
CREATE TABLE source_cache (
  source TEXT NOT NULL,             -- 'openlibrary', 'anilist', 'hardcover', 'demo'
  key TEXT NOT NULL,                -- the request, normalised (e.g. 'search:title=…|author=…')
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL,            -- JSON as received
  PRIMARY KEY (source, key)
);

-- Candidate matches for each item, scored (§11.2). Facts, derived from source_cache; rebuilt
-- on every lookup of the item. `data` is the normalised record (title, authors, rating…).
CREATE TABLE item_matches (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  score REAL NOT NULL,
  rank INTEGER NOT NULL,            -- 1 = best for this source
  evidence TEXT NOT NULL DEFAULT '{}', -- JSON: what agreed and what conflicted
  data TEXT NOT NULL,               -- JSON: the normalised source record
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, source, source_id)
);
CREATE INDEX item_matches_item ON item_matches (item_id, source, rank);

-- Per item and source: when it was looked up and at which matching version, so a cancelled
-- lookup resumes and failures are retried (§9.6).
CREATE TABLE lookup_state (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,          -- MATCH_VERSION it was scored at
  query TEXT NOT NULL,               -- what was asked; a changed title or author asks again
  looked_up_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'provisional', 'tie', 'none', 'failed', 'skipped')),
  error TEXT,
  PRIMARY KEY (item_id, source)
);

-- The decision the matching made for an item (§11.2): a fact, recomputed from item_matches.
ALTER TABLE items ADD COLUMN identity TEXT NOT NULL DEFAULT 'unidentified'
  CHECK (identity IN ('unidentified', 'provisional', 'tie', 'accepted'));
ALTER TABLE items ADD COLUMN identity_score REAL;
ALTER TABLE items ADD COLUMN match_source TEXT;      -- the chosen match, when there is one
ALTER TABLE items ADD COLUMN match_source_id TEXT;

-- Owner identity decisions (§11.4). Owner data: never overwritten by a lookup.
--   match_override: 'source:id' confirmed by the owner, or 'none' (leave unidentified).
--   wrong_match_at: "Not this, because… Wrong book" (§13.8) sends the item to tier 2.
ALTER TABLE user_item ADD COLUMN match_override TEXT;
ALTER TABLE user_item ADD COLUMN wrong_match_at TEXT;

-- Candidates the owner said are NOT this item: never accepted again (§7, §11.4).
CREATE TABLE candidates_rejected (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  score REAL,                       -- the candidate's score when rejected (match quality report)
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, source, source_id)
);

-- Needs review rows the owner deferred (until a date) or dismissed (§11.4). `key` names the
-- row: a review_items key, or a computed row's id ('identity:<item>', 'pdf:<file>').
CREATE TABLE review_state (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('deferred', 'dismissed')),
  until TEXT,
  updated_at TEXT NOT NULL
);

-- "Not this, because…" answers (§13.8), read by the quality sessions (§17.2).
CREATE TABLE pick_feedback (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,            -- kept even if the item is later merged away (aliases resolve it)
  mode TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '{}', -- JSON: time control, filters
  reason TEXT NOT NULL CHECK (reason IN ('already_read', 'wrong_book', 'not_in_mood', 'not_interested', 'other')),
  note TEXT,
  created_at TEXT NOT NULL
);

-- API keys and tokens, kept apart from settings so backups and exports never include them (§6.3).
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Lookup runs: progress, counts, errors, cancelled (§7 enrich_runs).
CREATE TABLE enrich_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT NOT NULL DEFAULT '{}'
);
