-- Opening-page text a scan read from a file, for identity review (the book page's
-- "Identify using bundle details and opening pages"). Kept apart from files.metadata, which
-- lookups and fact refreshes parse often: this is up to tens of KB per file, read only there.
CREATE TABLE file_opening_text (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  pages TEXT NOT NULL -- JSON array of { label, text }
);
