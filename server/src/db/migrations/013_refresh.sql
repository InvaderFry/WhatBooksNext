-- Automatic refresh (ratings plan stage 4). lookup_state is backed up as a whole table, so these
-- columns travel with backups and full snapshots. Every column is nullable or has a default, so
-- older backups still restore.

-- The record the app accepted on its own for this item and source. Later lookups keep it (a
-- refresh or a re-score never switches it); "Look up again" releases it. NULL: none remembered.
ALTER TABLE lookup_state ADD COLUMN accepted_source_id TEXT;

-- A different record that a later lookup preferred while the remembered one was kept. Needs
-- review shows it as "Check this match" until the owner decides.
ALTER TABLE lookup_state ADD COLUMN rival_source_id TEXT;

-- When the source last actually answered over the network (not a re-read of the cache). Filled
-- from looked_up_at for earlier lookups when the app starts.
ALTER TABLE lookup_state ADD COLUMN last_answer_at TEXT;

-- Not before then: set when the source's daily allowance ran out, and for retries after failures.
ALTER TABLE lookup_state ADD COLUMN next_eligible_at TEXT;

-- Failed lookups in a row, for the 1-, 3- and 7-day retries.
ALTER TABLE lookup_state ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
