-- When each folder's first scan completed (PLAN.md §13.5 new arrivals, §13.7 first-seen dates).
-- Books first seen up to then came with the folder; anything first seen later is a new arrival.
-- Before this, "first scan" meant "first seen within a day of adding the folder". Existing
-- folders keep that answer: the latest first-seen time within that day stands in for the
-- first scan's completion. A folder never scanned completely stays null (nothing is new yet).
ALTER TABLE folders ADD COLUMN first_complete_scan_at TEXT;

UPDATE folders SET first_complete_scan_at = (
  SELECT MAX(f.first_seen_at) FROM files f
  WHERE f.folder_id = folders.id
    AND f.first_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', folders.created_at, '+1 day')
)
WHERE last_complete_scan_at IS NOT NULL;
