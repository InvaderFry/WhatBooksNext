-- Milestone 5: all modes and taste. PLAN.md §13.6, §13.10. Owner data, nullable, backed up with
-- the rest of user_item.

-- "Still reading?" (§13.6): Snooze hides an in-progress book from the digest until this date.
ALTER TABLE user_item ADD COLUMN still_reading_snoozed_until TEXT;

-- "Still relevant?" (§13.10): Decide later moves a tech book to the end of the review list.
ALTER TABLE user_item ADD COLUMN relevance_deferred_at TEXT;
