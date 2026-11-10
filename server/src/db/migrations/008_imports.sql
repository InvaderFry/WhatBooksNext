-- Milestone 4, part 5: store titles and imports. PLAN.md §14.

-- Which import row became which item, so importing the same file again never duplicates
-- anything (§14 "imports are repeatable"). A row is recognised by its ISBN when it has one,
-- otherwise by normalised title + author + store.
CREATE TABLE import_keys (
  source TEXT NOT NULL,              -- 'store_csv', 'calibre', 'goodreads', 'storygraph'
  row_key TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, row_key)
);
CREATE INDEX import_keys_item ON import_keys (item_id);
