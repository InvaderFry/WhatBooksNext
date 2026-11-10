-- Milestone 4, part 1: series as their own rows, and gaps. PLAN.md §7, §8, §12.5, §13.4.
-- Every new column is nullable or has a default, so older backups still restore.

-- A series is found again by this key (kind group + its name, normalised), so its id stays
-- the same from one rebuild to the next. Null only for rows restored from an older backup,
-- which the next rebuild matches by name.
ALTER TABLE series ADD COLUMN match_key TEXT;
CREATE UNIQUE INDEX series_match_key ON series (match_key) WHERE match_key IS NOT NULL;
-- Which source said whether the story is finished ('hardcover', 'anilist', 'owner'…).
ALTER TABLE series ADD COLUMN status_source TEXT;

-- What an item's number counts: a 'volume' (or a book in a series) or an 'issue'. Gaps are
-- worked out per unit: issue 12 and volume 2 aren't on one scale. Derived, like series_id.
ALTER TABLE items ADD COLUMN series_unit TEXT CHECK (series_unit IN ('volume', 'issue'));
CREATE INDEX items_series ON items (series_id) WHERE series_id IS NOT NULL;

-- The owner's corrections to an item's series (owner data, never changed by scans or lookups).
--   series_override: the series name; '' means "not part of a series"; null lets the app decide.
--   series_position_override: its number in the series; null lets the app decide.
ALTER TABLE user_item ADD COLUMN series_override TEXT;
ALTER TABLE user_item ADD COLUMN series_position_override REAL;

-- The owner's corrections to a series as a whole (owner data, §6.5).
CREATE TABLE series_user (
  series_id TEXT PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
  status_override TEXT CHECK (status_override IN ('finished', 'ongoing')),
  updated_at TEXT NOT NULL
);
