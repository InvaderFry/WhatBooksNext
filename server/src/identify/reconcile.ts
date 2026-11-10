import { MIN_SUGGESTION_KEY_LENGTH } from '../config.ts';
import type { DB } from '../db/database.ts';
import { newId, nowIso, parseJson } from '../util.ts';
import { SOURCE_LABELS, type SourceName } from '../sources/types.ts';
import {
  groupUnassignedFiles,
  hashesDisagree,
  knownConflict,
  sameFormatGroup,
} from './grouping.ts';
import {
  filesOfItem,
  hasOwnerData,
  mergeInto,
  refreshPrimary,
  removeOrphanItems,
  type FileFacts,
} from './items.ts';

/**
 * What the deep pass's findings mean for identity (PLAN.md §9.3, §11.3). Runs after every
 * scan, in one transaction:
 *
 *  1. Archives that aren't comics leave their items (§9.1).
 *  2. Groups made by name in M1 whose files turn out to conflict — copies whose hashes
 *     disagree, or a known language / abridgment / edition conflict — are split automatically
 *     if the item has no owner data; otherwise Needs review, tier 1, and they stay grouped.
 *  3. Copies by full hash: two items whose files have the same full hash are one item. This
 *     also transfers history for a renamed file (size + full hash). If both items have owner
 *     data, it's a tier-1 review row instead (merging history needs the M4 preview).
 *  4. Candidate moves: a missing file and a new file with the same size and partial hash under
 *     a different name, when full hashes can't be compared → tier 1, never automatic.
 *  5. Cross-folder suggestions (rule 3): the same base name in different folders, with a
 *     different format or size → tier 4.
 *
 * A similar name alone never moves history (§9.3), and nothing here merges two items that
 * both have owner data.
 */

export interface ReconcileResult {
  excluded: number;
  split: number;
  mergedByHash: number;
  reviewAdded: number;
  /** Items whose files changed: their facts and primary need refreshing. */
  touchedItems: string[];
}

type Row = FileFacts & { item_id: string | null; excluded: number };

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function addReview(
  db: DB,
  r: {
    kind: string;
    tier: number;
    key: string;
    itemIds: string[];
    fileIds: string[];
    detail: object;
  },
): boolean {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO review_items (id, kind, tier, key, item_ids, file_ids, detail, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT (key) DO NOTHING`,
    )
    .run(
      newId(),
      r.kind,
      r.tier,
      r.key,
      JSON.stringify(r.itemIds),
      JSON.stringify(r.fileIds),
      JSON.stringify(r.detail),
      now,
      now,
    );
  return res.changes > 0;
}

/** Why two files in one item can't be the same work, or null. */
export function groupConflict(a: FileFacts, b: FileFacts): string | null {
  const copies = a.name.toLowerCase() === b.name.toLowerCase() && a.size === b.size;
  if (copies && hashesDisagree(a, b)) return 'Same name and size, but the contents differ.';
  const formatGroup =
    a.folder_id === b.folder_id && a.rel_dir === b.rel_dir && a.compare_key === b.compare_key;
  if (formatGroup && knownConflict(a, b)) {
    if (a.language && b.language && a.language !== b.language)
      return `Different languages (${a.language} and ${b.language}).`;
    if (
      a.edition_number !== null &&
      b.edition_number !== null &&
      a.edition_number !== b.edition_number
    )
      return `Different editions (${a.edition_number} and ${b.edition_number}).`;
    return 'One is abridged and the other isn’t.';
  }
  return null;
}

/** Splits an item with no owner data: its files are grouped again under the current rules. */
function splitItem(db: DB, itemId: string): string[] {
  const files = filesOfItem(db, itemId);
  const primary = db
    .prepare('SELECT file_id FROM item_files WHERE item_id = ? AND is_primary = 1')
    .pluck()
    .get(itemId) as string | undefined;
  db.prepare('DELETE FROM item_files WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM user_item WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
  groupUnassignedFiles(db);
  const itemOf = db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
  const now = nowIso();
  // The old id lives on as an alias of the item that kept its primary file (§6.5).
  const heir = primary ? (itemOf.get(primary) as string | undefined) : undefined;
  if (heir) {
    db.prepare('UPDATE id_aliases SET new_id = ? WHERE new_id = ?').run(heir, itemId);
    db.prepare(
      'INSERT OR REPLACE INTO id_aliases (old_id, new_id, created_at) VALUES (?, ?, ?)',
    ).run(itemId, heir, now);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
    ).run('item', itemId, now);
  }
  return [...new Set(files.map((f) => itemOf.get(f.id) as string).filter(Boolean))];
}

export function reconcileIdentity(db: DB, changedFileIds: string[]): ReconcileResult {
  const result: ReconcileResult = {
    excluded: 0,
    split: 0,
    mergedByHash: 0,
    reviewAdded: 0,
    touchedItems: [],
  };
  const touched = new Set<string>();
  const byId = db.prepare(
    'SELECT f.*, x.item_id FROM files f LEFT JOIN item_files x ON x.file_id = f.id WHERE f.id = ?',
  );
  const changed = changedFileIds
    .map((id) => byId.get(id) as Row | undefined)
    .filter((r): r is Row => Boolean(r));

  // 1. Not comics: out of the library.
  for (const f of changed) {
    if (f.excluded !== 1 || !f.item_id) continue;
    db.prepare('DELETE FROM item_files WHERE file_id = ?').run(f.id);
    refreshPrimary(db, f.item_id);
    touched.add(f.item_id);
    result.excluded++;
  }

  // 2. Conflicts inside groups.
  const items = new Set(
    changed.filter((f) => f.excluded !== 1 && f.item_id).map((f) => f.item_id!),
  );
  for (const itemId of items) {
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) continue;
    const files = filesOfItem(db, itemId);
    const conflicts: { a: FileFacts; b: FileFacts; why: string }[] = [];
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const why = groupConflict(files[i]!, files[j]!);
        if (why) conflicts.push({ a: files[i]!, b: files[j]!, why });
      }
    if (conflicts.length === 0) continue;
    if (!hasOwnerData(db, itemId)) {
      for (const id of splitItem(db, itemId)) touched.add(id);
      result.split++;
      continue;
    }
    for (const c of conflicts) {
      if (
        addReview(db, {
          kind: 'group_conflict',
          tier: 1,
          key: `group_conflict:${itemId}:${pairKey(c.a.id, c.b.id)}`,
          itemIds: [itemId],
          fileIds: [c.a.id, c.b.id],
          detail: { why: c.why },
        })
      )
        result.reviewAdded++;
    }
  }

  // 3. Copies by full hash, whatever their names.
  const sameHash = db.prepare(
    `SELECT f.*, x.item_id FROM files f JOIN item_files x ON x.file_id = f.id
     WHERE f.full_hash = ? AND f.size > 0 AND f.excluded = 0 AND x.item_id != ?`,
  );
  const itemOf = db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
  const created = db.prepare('SELECT created_at FROM items WHERE id = ?').pluck();
  for (const f0 of changed) {
    if (!f0.full_hash || f0.size === 0 || f0.excluded === 1) continue;
    let mine = itemOf.get(f0.id) as string | undefined;
    if (!mine) continue;
    for (const other of sameHash.all(f0.full_hash, mine) as Row[]) {
      const theirs = itemOf.get(other.id) as string | undefined;
      mine = itemOf.get(f0.id) as string | undefined;
      if (!theirs || !mine || theirs === mine) continue;
      const mineHas = hasOwnerData(db, mine);
      const theirsHas = hasOwnerData(db, theirs);
      if (mineHas && theirsHas) {
        if (
          addReview(db, {
            kind: 'copy_conflict',
            tier: 1,
            key: `copy_conflict:${pairKey(mine, theirs)}`,
            itemIds: [mine, theirs],
            fileIds: [f0.id, other.id],
            detail: { why: 'The same file is on two items that both have history.' },
          })
        )
          result.reviewAdded++;
        continue;
      }
      // Keep the item with history; with none on either side, keep the older one.
      const keep =
        theirsHas || (!mineHas && (created.get(theirs) as string) <= (created.get(mine) as string))
          ? theirs
          : mine;
      const drop = keep === theirs ? mine : theirs;
      mergeInto(db, drop, keep);
      touched.add(keep);
      result.mergedByHash++;
    }
  }

  // 4. Candidate moves that need the owner: same size + partial hash, different name, and the
  // full hashes can't be compared.
  const movedCandidates = db.prepare(
    `SELECT f.*, x.item_id FROM files f JOIN item_files x ON x.file_id = f.id
     WHERE f.availability = 'missing' AND f.size = ? AND f.partial_hash = ? AND f.id != ?`,
  );
  for (const f0 of changed) {
    const n = byId.get(f0.id) as Row | undefined;
    if (!n || n.availability !== 'present' || !n.partial_hash || !n.item_id || n.size === 0)
      continue;
    for (const m of movedCandidates.all(n.size, n.partial_hash, n.id) as Row[]) {
      if (!m.item_id || m.item_id === n.item_id) continue;
      if (m.name.toLowerCase() === n.name.toLowerCase()) continue; // handled by name grouping
      if (m.full_hash && n.full_hash) continue; // comparable: equal ones merged above, unequal differ
      if (
        addReview(db, {
          kind: 'move',
          tier: 1,
          key: `move:${m.id}:${n.id}`,
          itemIds: [m.item_id, n.item_id],
          fileIds: [m.id, n.id],
          detail: {
            why: 'A missing file and a new file have the same size and the same start and end, under different names.',
          },
        })
      )
        result.reviewAdded++;
    }
  }

  result.reviewAdded += addCrossFolderSuggestions(db);
  markObsoleteReviews(db);
  removeOrphanItems(db);
  result.touchedItems = [...touched].filter((id) =>
    db.prepare('SELECT 1 FROM items WHERE id = ?').get(id),
  );
  return result;
}

/**
 * §11.3 rule 3: the same base name in different folders, with a different format or size
 * (an EPUB here, only a PDF there; a re-issued file) → a suggestion, never a silent merge.
 */
export function addCrossFolderSuggestions(db: DB): number {
  const rows = db
    .prepare(
      `SELECT f.*, x.item_id FROM files f JOIN item_files x ON x.file_id = f.id
       WHERE f.excluded = 0 AND length(f.compare_key) >= ? AND f.compare_key IN (
         SELECT f2.compare_key FROM files f2 JOIN item_files x2 ON x2.file_id = f2.id
         WHERE f2.excluded = 0 GROUP BY f2.compare_key HAVING COUNT(DISTINCT x2.item_id) > 1)
       ORDER BY f.compare_key`,
    )
    .all(MIN_SUGGESTION_KEY_LENGTH) as Row[];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byKey.has(r.compare_key)) byKey.set(r.compare_key, []);
    byKey.get(r.compare_key)!.push(r);
  }
  let added = 0;
  for (const files of byKey.values()) {
    const seen = new Set<string>();
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i]!;
        const b = files[j]!;
        if (a.item_id === b.item_id) continue;
        const sameDir = a.folder_id === b.folder_id && a.rel_dir === b.rel_dir;
        // Same folder: rule 2 groups new files automatically. Two that are already apart —
        // because they were scanned before a rule learned they're versions of one book (an
        // "optimized" copy), or because the owner split them — are only suggested, so an
        // owner's split is never undone silently. A declined suggestion isn't asked again.
        if (sameDir && !sameFormatGroup(a, b)) continue;
        if (knownConflict(a, b)) continue; // different editions or languages: separate works
        const key = `cross_folder:${pairKey(a.item_id!, b.item_id!)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          addReview(db, {
            kind: 'cross_folder',
            // Same folder, same name: very likely one book, so it's shown, not tucked away.
            tier: sameDir ? 2 : 4,
            key,
            itemIds: [a.item_id!, b.item_id!].sort(),
            fileIds: [a.id, b.id],
            detail: {
              why: sameDir
                ? `Another version of this book in the same folder${
                    a.quality_tag || b.quality_tag
                      ? ` (${(a.quality_tag ?? b.quality_tag)!.toLowerCase()})`
                      : ''
                  }.`
                : a.format !== b.format
                  ? `The same name as a ${b.format.toUpperCase()} in another folder.`
                  : a.size === b.size
                    ? 'The same name and size in another folder, but the contents differ.'
                    : 'The same name in another folder, but a different size.',
            },
          })
        )
          added++;
      }
  }
  return added;
}

/** Open review rows whose items have since been merged, split or removed no longer apply. */
export function markObsoleteReviews(db: DB): void {
  const open = db
    .prepare("SELECT id, kind, item_ids, file_ids FROM review_items WHERE status = 'open'")
    .all() as { id: string; kind: string; item_ids: string; file_ids: string }[];
  const exists = db.prepare('SELECT 1 FROM items WHERE id = ?');
  const itemOf = db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
  const mark = db.prepare(
    "UPDATE review_items SET status = 'obsolete', updated_at = ? WHERE id = ?",
  );
  const now = nowIso();
  for (const r of open) {
    const items = parseJson<string[]>(r.item_ids, []);
    const files = parseJson<string[]>(r.file_ids, []);
    const fileItems = files.map((f) => itemOf.get(f) as string | undefined);
    let obsolete = items.some((i) => !exists.get(i)) || fileItems.some((i) => !i);
    if (r.kind === 'group_conflict') obsolete ||= fileItems[0] !== fileItems[1];
    else obsolete ||= fileItems[0] === fileItems[1];
    if (obsolete) mark.run(now, r.id);
  }
}

/**
 * §11.3 rule 4: two items that the lookups matched to the same record at a source ("March Book
 * Two" and "March: Book Two") are probably one book under two names. Unless that match is
 * corroborated by an identifier on both, it's a suggestion (tier 4), never a silent merge.
 * A known edition or language conflict between them means separate works: no suggestion.
 */
export function addSameMatchSuggestions(db: DB): number {
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.match_source, i.match_source_id, f.*
       FROM items i JOIN item_files x ON x.item_id = i.id AND x.is_primary = 1
       JOIN files f ON f.id = x.file_id
       WHERE i.identity IN ('accepted', 'provisional') AND i.match_source IS NOT NULL
         AND (i.match_source || ':' || i.match_source_id) IN (
           SELECT match_source || ':' || match_source_id FROM items
           WHERE identity IN ('accepted', 'provisional') AND match_source IS NOT NULL
           GROUP BY match_source, match_source_id HAVING COUNT(*) > 1)
       ORDER BY i.match_source, i.match_source_id`,
    )
    .all() as (Row & { match_source: string; match_source_id: string })[];
  const byWork = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.match_source}:${r.match_source_id}`;
    if (!byWork.has(k)) byWork.set(k, []);
    byWork.get(k)!.push(r);
  }
  let added = 0;
  for (const [work, files] of byWork) {
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i]!;
        const b = files[j]!;
        if (knownConflict(a, b)) continue;
        const key = `same_match:${pairKey(a.item_id!, b.item_id!)}`;
        if (
          addReview(db, {
            kind: 'cross_folder',
            tier: 4,
            key,
            itemIds: [a.item_id!, b.item_id!].sort(),
            fileIds: [a.id, b.id],
            detail: {
              why: `Both were matched to the same book on ${SOURCE_LABELS[work.split(':')[0] as SourceName] ?? 'an online source'}, under different names.`,
            },
          })
        )
          added++;
      }
  }
  return added;
}
