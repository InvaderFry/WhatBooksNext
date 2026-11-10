-- Milestone 4, part 4: the merge/split undo stack. PLAN.md §7, §11.4, §20 (last 20 kept).

-- Each merge or split keeps the exact state of the items it touched from just before it, so
-- undo can put them back. Undo is offered only while those items haven't been edited or touched
-- by a later merge or split; otherwise the owner gets a split with a preview instead.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'split')),
  summary TEXT NOT NULL,             -- plain words, e.g. 'Merged “A” into “B”'
  before TEXT NOT NULL,              -- JSON: the rows of every touched item, and their aliases
  item_ids TEXT NOT NULL,            -- JSON: the items as they were right after
  stamps TEXT NOT NULL,              -- JSON: { itemId: user_item.updated_at right after }
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX operations_created ON operations (created_at);
