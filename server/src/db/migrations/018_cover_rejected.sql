-- "Wrong cover" on a book's page: the online covers the owner turned down for this book, as a
-- JSON array of "source:record" keys (the match the picture came from). The cover fetcher skips
-- them and tries the book's next confident match. An owner correction, so it lives in user_item
-- and is backed up with it; "Show online covers again" clears it.
ALTER TABLE user_item ADD COLUMN cover_rejected TEXT;
