-- Each audio part looks up its book's siblings, including parts in other disc directories.
-- files_dir can narrow this query only to folder_id; it has rel_dir in the second position.
CREATE INDEX files_audio_book ON files (folder_id, book_dir, compare_key)
  WHERE format = 'audio' AND excluded = 0;
