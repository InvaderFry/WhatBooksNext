-- Fills owner_splits from history more completely than 024 did. Owner corrections win: a
-- rescan's audiobook regrouping must not join books the owner split apart.
--
-- 1. Splits still in the undo list, rebuilt from the files the original book had just before
--    the split (operations.before), by where each file is now. Items merged away since then are
--    followed through id_aliases (kept flat: every alias points at a live item), so a split-off
--    book later merged into a third book still counts. Replaces 024's rows for those splits.
-- 2. Splits made in Needs review before 023: an accepted group conflict (its only action that
--    is accepted is "split") left its files in different books.
--
-- A side that comes out empty (the owner merged the two back together) records nothing: such a
-- row couldn't keep anything apart.

-- Only rows whose split is still in the undo list are rebuilt; a row whose undo record is gone
-- (pruned after 20, or cleared by a restore) is kept as 024 made it.
DELETE FROM owner_splits
 WHERE id LIKE 'from-undo-%'
   AND operation_id IN (SELECT id FROM operations WHERE kind = 'split' AND undone_at IS NULL);

INSERT INTO owner_splits (id, operation_id, kept_file_ids, moved_file_ids, created_at)
SELECT 'from-undo-' || o.id,
       o.id,
       (SELECT json_group_array(json_extract(b.value, '$.file_id'))
          FROM json_each(o.before, '$.tables.item_files') b
          JOIN item_files x ON x.file_id = json_extract(b.value, '$.file_id')
         WHERE x.item_id = COALESCE(
                 (SELECT new_id FROM id_aliases WHERE old_id = json_extract(o.item_ids, '$[0]')),
                 json_extract(o.item_ids, '$[0]'))),
       (SELECT json_group_array(json_extract(b.value, '$.file_id'))
          FROM json_each(o.before, '$.tables.item_files') b
          JOIN item_files x ON x.file_id = json_extract(b.value, '$.file_id')
         WHERE x.item_id = COALESCE(
                 (SELECT new_id FROM id_aliases WHERE old_id = json_extract(o.item_ids, '$[1]')),
                 json_extract(o.item_ids, '$[1]'))),
       o.created_at
  FROM operations o
 WHERE o.kind = 'split' AND o.undone_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM owner_splits s WHERE s.operation_id = o.id);

INSERT INTO owner_splits (id, operation_id, kept_file_ids, moved_file_ids, created_at)
SELECT 'from-review-' || r.id,
       NULL,
       (SELECT json_group_array(j.value) FROM json_each(r.file_ids) j
          JOIN item_files x ON x.file_id = j.value
         WHERE x.item_id = (SELECT item_id FROM item_files
                             WHERE file_id = json_extract(r.file_ids, '$[0]'))),
       (SELECT json_group_array(j.value) FROM json_each(r.file_ids) j
          JOIN item_files x ON x.file_id = j.value
         WHERE x.item_id != (SELECT item_id FROM item_files
                              WHERE file_id = json_extract(r.file_ids, '$[0]'))),
       r.updated_at
  FROM review_items r
 WHERE r.kind = 'group_conflict' AND r.status = 'accepted'
   AND NOT EXISTS (SELECT 1 FROM owner_splits s WHERE s.id = 'from-review-' || r.id);

DELETE FROM owner_splits
 WHERE (id LIKE 'from-undo-%' OR id LIKE 'from-review-%')
   AND (kept_file_ids = '[]' OR moved_file_ids = '[]');
