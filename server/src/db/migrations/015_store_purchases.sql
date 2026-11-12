-- Store purchases imported from a collector's file (docs/plans/get-store-purchase-imports.md,
-- "1b"). One row per book the store says the owner owns, per account. Backed up (it's how a
-- repeat import recognises a book and how "not seen in your latest scan" works).
CREATE TABLE store_purchases (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('kindle', 'google_play', 'kobo', 'globalcomix')),
  -- An opaque scope from the file, or the owner's name for a second account; 'default' otherwise.
  account_scope TEXT NOT NULL DEFAULT 'default',
  store_record_id TEXT NOT NULL,
  id_kind TEXT NOT NULL,
  unit TEXT CHECK (unit IN ('issue', 'volume', 'collection', 'book')),
  acquisition TEXT NOT NULL CHECK (acquisition IN ('purchase', 'free_claim', 'uncertain')),
  acquired_at TEXT,
  acquired_precision TEXT CHECK (acquired_precision IN ('day', 'month', 'year')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- The latest complete scan of this account that found it. NULL: only partial scans so far.
  last_complete_scan_at TEXT,
  adapter_version TEXT NOT NULL,
  -- Set when a complete scan of the same account didn't find it ("Not seen in your latest
  -- Kindle scan"). Cleared when a scan finds it again.
  not_seen_since TEXT,
  -- The owner chose Keep for that: not asked again until it is seen and then missed again.
  not_seen_kept INTEGER NOT NULL DEFAULT 0 CHECK (not_seen_kept IN (0, 1)),
  UNIQUE (service, account_scope, id_kind, store_record_id)
);
CREATE INDEX store_purchases_item ON store_purchases(item_id);

-- A log of imports (time, store, collector version, completeness, counts). No titles. Like
-- scan_runs, it is left out of backups.
CREATE TABLE store_import_runs (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  service TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  completion TEXT NOT NULL,
  completion_reason TEXT NOT NULL,
  counts TEXT NOT NULL
);
