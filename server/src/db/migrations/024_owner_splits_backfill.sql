-- Splits made before 023 lived only in the undo history. Keep those the owner hasn't undone
-- (the original item's files stayed, the new item's files moved), so a rescan after the
-- audiobook grouping change can't join them again. Safe to run on a database 023 already reached.
INSERT INTO owner_splits (id, operation_id, kept_file_ids, moved_file_ids, created_at)
SELECT 'from-undo-' || o.id,
       o.id,
       (SELECT json_group_array(file_id) FROM item_files
         WHERE item_id = json_extract(o.item_ids, '$[0]')),
       (SELECT json_group_array(file_id) FROM item_files
         WHERE item_id = json_extract(o.item_ids, '$[1]')),
       o.created_at
  FROM operations o
 WHERE o.kind = 'split' AND o.undone_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM owner_splits s WHERE s.operation_id = o.id);
