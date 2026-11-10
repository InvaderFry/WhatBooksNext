-- Milestone 4, part 3: what a collected edition collects. PLAN.md §7, §12.5, §13.4.

-- A collected edition (a trade paperback, an omnibus) covers ranges of a series' issues.
--   suggested: a source says so (Metron's reprints); derived, replaced by later lookups.
--   confirmed: the owner said so, or typed it in. Owner data: lookups never change it.
--   rejected:  the owner said a suggestion is wrong; it's never suggested again.
-- Only confirmed coverage fills gaps and shares reading state (§12.5).
CREATE TABLE collection_coverage (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  first_num REAL NOT NULL,
  last_num REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('suggested', 'confirmed', 'rejected')),
  source TEXT NOT NULL,              -- 'owner', 'metron'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (last_num >= first_num)
);
CREATE INDEX collection_coverage_item ON collection_coverage (item_id);
CREATE INDEX collection_coverage_series ON collection_coverage (series_id);
