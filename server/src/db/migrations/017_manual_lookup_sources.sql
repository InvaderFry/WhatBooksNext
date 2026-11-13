-- Explicit source choices are owner intent, independent of the automatic source plan.
-- lookup_state is backed up as a whole table; older backups receive the default.
ALTER TABLE lookup_state ADD COLUMN manually_selected INTEGER NOT NULL DEFAULT 0
  CHECK (manually_selected IN (0, 1));
