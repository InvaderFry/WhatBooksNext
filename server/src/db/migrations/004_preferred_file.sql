-- After M3: the owner can choose which of a book's files opens by default ("Use this file by
-- default"). Owner data: kept in user_item (backed up), never changed by scans. Nullable, so
-- older backups still restore.
ALTER TABLE user_item ADD COLUMN preferred_file_id TEXT;
