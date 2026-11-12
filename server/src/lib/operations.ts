import { createHash } from 'node:crypto';
import { UNDO_STACK_SIZE } from '../config.ts';
import type { DB } from '../db/database.ts';
import { groupUnassignedFiles } from '../identify/grouping.ts';
import {
  createItemForFiles,
  filesOfItem,
  refreshFactsOfItems,
  refreshPrimary,
} from '../identify/items.ts';
import { applyIdentity } from '../identify/lookups.ts';
import { markObsoleteReviews } from '../identify/reconcile.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import { DNF_LABELS_PLAIN, PROGRESS_LABELS_PLAIN } from './labels.ts';
import { ensureUserRow } from './progress.ts';

/**
 * Merge and split with a preview of conflicts, and an undo stack (PLAN.md §11.4, §20):
 *  - a merge shows only what conflicts ("one is Halfway, the other Finished: keep which?");
 *    completed reading is never credited twice;
 *  - a split says which files, and whether the reading history, go to the new item;
 *  - any of the last 20 can be undone, back to the exact prior state, while the items haven't
 *    been edited or touched by a later merge or split. Otherwise a split (or merge) with a
 *    preview is offered instead, so nothing done since is silently lost.
 */

/** Tables holding an item's rows, parents first. pick_feedback stays put (aliases resolve it). */
const ITEM_TABLES: [table: string, key: string][] = [
  ['items', 'id'],
  ['user_item', 'item_id'],
  ['item_files', 'item_id'],
  ['locations', 'item_id'],
  ['item_matches', 'item_id'],
  ['lookup_state', 'item_id'],
  ['candidates_rejected', 'item_id'],
  ['collection_coverage', 'item_id'],
  ['import_keys', 'item_id'],
  ['store_purchases', 'item_id'],
];

export interface Snapshot {
  ids: string[];
  tables: Record<string, Record<string, unknown>[]>;
  aliases: Record<string, unknown>[];
  shortlist?: { before: ShortlistPlace[]; after?: ShortlistPlace[] };
}

type ShortlistPlace = { item_id: string; shortlist_position: number };
function shortlistState(db: DB): ShortlistPlace[] {
  return db
    .prepare(
      `SELECT item_id, shortlist_position FROM user_item
    WHERE shortlist_position IS NOT NULL ORDER BY shortlist_position`,
    )
    .all() as ShortlistPlace[];
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

export function snapshot(db: DB, ids: string[]): Snapshot {
  const tables: Snapshot['tables'] = {};
  for (const [t, k] of ITEM_TABLES)
    tables[t] = db
      .prepare(`SELECT * FROM ${t} WHERE ${k} IN (${marks(ids.length)})`)
      .all(...ids) as Record<string, unknown>[];
  const aliases = db
    .prepare(
      `SELECT * FROM id_aliases WHERE old_id IN (${marks(ids.length)}) OR new_id IN (${marks(ids.length)})`,
    )
    .all(...ids, ...ids) as Record<string, unknown>[];
  return { ids, tables, aliases, shortlist: { before: shortlistState(db) } };
}

function insertRows(db: DB, table: string, rows: Record<string, unknown>[]): void {
  for (const r of rows) {
    const keys = Object.keys(r);
    db.prepare(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`,
    ).run(r);
  }
}

/** Puts the snapshot's items back exactly, replacing whatever those ids (and `alsoIds`) hold now. */
function restore(db: DB, snap: Snapshot, alsoIds: string[]): void {
  // Reverse this operation's compaction only if the owner hasn't since changed the queue.
  const restoreQueue =
    snap.shortlist?.after &&
    JSON.stringify(shortlistState(db)) === JSON.stringify(snap.shortlist.after);
  const ids = [...new Set([...snap.ids, ...alsoIds])];
  const files = snap.tables.item_files!.map((r) => r.file_id as string);
  if (files.length)
    db.prepare(`DELETE FROM item_files WHERE file_id IN (${marks(files.length)})`).run(...files);
  for (const [t, k] of [...ITEM_TABLES].reverse())
    db.prepare(`DELETE FROM ${t} WHERE ${k} IN (${marks(ids.length)})`).run(...ids);
  db.prepare(
    `DELETE FROM id_aliases WHERE old_id IN (${marks(ids.length)}) OR new_id IN (${marks(ids.length)})`,
  ).run(...ids, ...ids);
  if (restoreQueue)
    db.prepare(
      'UPDATE user_item SET shortlist_position = NULL WHERE shortlist_position IS NOT NULL',
    ).run();
  // A shortlist place taken since by another book: this one goes to the end of the list.
  const occupied = new Set(
    db
      .prepare('SELECT shortlist_position FROM user_item WHERE shortlist_position IS NOT NULL')
      .pluck()
      .all() as number[],
  );
  let max = Math.max(0, ...occupied);
  const users = snap.tables.user_item!.map((u) => {
    const pos = u.shortlist_position as number | null;
    if (pos === null) return u;
    const place = occupied.has(pos) ? max + 1 : pos;
    occupied.add(place);
    max = Math.max(max, place);
    return { ...u, shortlist_position: place };
  });
  for (const [t] of ITEM_TABLES) insertRows(db, t, t === 'user_item' ? users : snap.tables[t]!);
  if (restoreQueue) {
    db.prepare(
      'UPDATE user_item SET shortlist_position = NULL WHERE shortlist_position IS NOT NULL',
    ).run();
    const set = db.prepare('UPDATE user_item SET shortlist_position = ? WHERE item_id = ?');
    for (const row of snap.shortlist!.before) set.run(row.shortlist_position, row.item_id);
  }
  insertRows(db, 'id_aliases', snap.aliases);
  db.prepare(
    `DELETE FROM deletions WHERE entity = 'item' AND entity_id IN (${marks(snap.ids.length)})`,
  ).run(...snap.ids);
  // Files that joined these items after the operation (a later scan) find a home again.
  groupUnassignedFiles(db);
}

function stampOf(db: DB, id: string): string {
  // Owner data lives beyond user_item. Undo must also preserve later store, coverage,
  // rejection and import decisions, while allowing scans to discover additional files.
  const state = {
    user: db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(id) ?? null,
    related: [
      ['locations', 'id'],
      ['collection_coverage', 'id'],
      ['import_keys', 'source, row_key'],
      ['store_purchases', 'id'],
      ['candidates_rejected', 'source, source_id'],
    ].map(([table, order]) =>
      db.prepare(`SELECT * FROM ${table} WHERE item_id = ? ORDER BY ${order}`).all(id),
    ),
  };
  return 'owner-v2:' + createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function record(
  db: DB,
  kind: 'merge' | 'split',
  summary: string,
  before: Snapshot,
  after: string[],
) {
  const id = newId();
  if (before.shortlist) before.shortlist.after = shortlistState(db);
  db.prepare(
    `INSERT INTO operations (id, kind, summary, before, item_ids, stamps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    summary,
    JSON.stringify(before),
    JSON.stringify(after),
    JSON.stringify(Object.fromEntries(after.map((i) => [i, stampOf(db, i)]))),
    nowIso(),
  );
  // Keep the last 20 (§20).
  db.prepare(
    `DELETE FROM operations WHERE id NOT IN
       (SELECT id FROM operations ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
  ).run(UNDO_STACK_SIZE);
  return id;
}

export function titleOf(db: DB, id: string): string {
  return (
    (db
      .prepare(
        'SELECT COALESCE(u.title_override, i.title) FROM items i LEFT JOIN user_item u ON u.item_id = i.id WHERE i.id = ?',
      )
      .pluck()
      .get(id) as string | undefined) ?? 'a book'
  );
}

/** After items' files or owner data move: primaries, facts, identity, series, review rows. */
function settle(db: DB, ids: string[]): void {
  const live = ids.filter((i) => db.prepare('SELECT 1 FROM items WHERE id = ?').get(i));
  for (const i of live) refreshPrimary(db, i);
  refreshFactsOfItems(db, live);
  for (const i of live) applyIdentity(db, i);
  markObsoleteReviews(db);
  syncSeries(db);
}

// ---- Merge -------------------------------------------------------------------------------------

/**
 * Owner data that can conflict, in groups that move together (a finish date belongs with its
 * progress). A group "has a value" when it differs from a fresh item's.
 */
const GROUPS: { field: string; label: string; cols: string[]; both?: boolean }[] = [
  {
    field: 'progress',
    label: 'Progress',
    cols: [
      'progress',
      'dnf_reason',
      'started_on',
      'started_precision',
      'finished_on',
      'finished_precision',
      'progress_at',
    ],
  },
  { field: 'rating', label: 'Your rating', cols: ['rating'] },
  { field: 'note', label: 'Note', cols: ['note'], both: true },
  { field: 'takeaway', label: 'Takeaway', cols: ['takeaway'], both: true },
  { field: 'triage', label: 'Triage', cols: ['triage', 'triage_at'] },
  { field: 'title', label: 'Your title', cols: ['title_override'] },
  { field: 'kind', label: 'Kind', cols: ['kind_override'] },
  { field: 'reference', label: 'Reference book', cols: ['reference_override'] },
  { field: 'effort', label: 'Effort', cols: ['effort_override'] },
  { field: 'icloud', label: 'In iCloud', cols: ['icloud_override'] },
  { field: 'hidden', label: 'Hidden', cols: ['hidden'] },
  { field: 'match', label: 'Confirmed online match', cols: ['match_override', 'wrong_match_at'] },
  { field: 'series', label: 'Series', cols: ['series_override', 'series_position_override'] },
  { field: 'acquired', label: 'Acquired', cols: ['acquired_on', 'acquired_precision'] },
];

type UserRow = Record<string, unknown>;

function hasValue(field: string, u: UserRow | undefined): boolean {
  if (!u) return false;
  const g = GROUPS.find((x) => x.field === field)!;
  if (field === 'progress') return u.progress !== 'not_started';
  if (field === 'hidden') return u.hidden === 1;
  return g.cols.some((c) => u[c] !== null && u[c] !== undefined);
}

function display(field: string, u: UserRow): string {
  switch (field) {
    case 'progress': {
      const p = PROGRESS_LABELS_PLAIN[u.progress as string] ?? String(u.progress);
      const dnf = u.dnf_reason
        ? ` (${DNF_LABELS_PLAIN[u.dnf_reason as string] ?? u.dnf_reason})`
        : '';
      const when =
        u.progress === 'finished' ? (u.finished_on ? `, ${u.finished_on}` : ', date unknown') : '';
      return `${p}${dnf}${when}`;
    }
    case 'rating':
      return `${u.rating}/10`;
    case 'hidden':
      return 'Hidden from the library';
    case 'reference':
      return u.reference_override === 1 ? 'Yes' : 'No';
    case 'series':
      return [
        u.series_override === '' ? 'not in a series' : u.series_override,
        u.series_position_override,
      ]
        .filter((x) => x !== null && x !== undefined)
        .join(' #');
    case 'acquired':
      return String(u.acquired_on ?? 'date unknown');
    default: {
      const g = GROUPS.find((x) => x.field === field)!;
      return String(u[g.cols[0]!] ?? '');
    }
  }
}

const same = (field: string, a: UserRow, b: UserRow) =>
  GROUPS.find((x) => x.field === field)!.cols.every(
    (c) => c.endsWith('_at') || (a[c] ?? null) === (b[c] ?? null),
  );

export interface MergeConflict {
  field: string;
  label: string;
  keep: string;
  other: string;
  allowBoth: boolean;
}

export interface MergePreview {
  keep: { id: string; title: string; files: number };
  other: { id: string; title: string; files: number };
  conflicts: MergeConflict[];
  /** Owner data only the other item has: comes along without asking. */
  carried: string[];
}

function userRow(db: DB, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(id) as UserRow | undefined;
}

function checkPair(db: DB, keepId: string, otherId: string) {
  if (keepId === otherId) throw new HttpError(400, 'Choose two different books.');
  for (const id of [keepId, otherId])
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id))
      throw new HttpError(404, 'No such item.');
}

export function previewMerge(db: DB, keepId: string, otherId: string): MergePreview {
  checkPair(db, keepId, otherId);
  const a = userRow(db, keepId);
  const b = userRow(db, otherId);
  const conflicts: MergeConflict[] = [];
  const carried: string[] = [];
  for (const g of GROUPS) {
    const ha = hasValue(g.field, a);
    const hb = hasValue(g.field, b);
    if (ha && hb && !same(g.field, a!, b!))
      conflicts.push({
        field: g.field,
        label: g.label,
        keep: display(g.field, a!),
        other: display(g.field, b!),
        allowBoth: Boolean(g.both),
      });
    else if (hb && !ha) carried.push(`${g.label}: ${display(g.field, b!)}`);
  }
  const files = (id: string) =>
    db.prepare('SELECT COUNT(*) FROM item_files WHERE item_id = ?').pluck().get(id) as number;
  return {
    keep: { id: keepId, title: titleOf(db, keepId), files: files(keepId) },
    other: { id: otherId, title: titleOf(db, otherId), files: files(otherId) },
    conflicts,
    carried,
  };
}

export type Choice = 'keep' | 'other' | 'both';

/**
 * Merges `otherId` into `keepId` with the owner's answer for each conflict. The other item's
 * files, places to read, coverage and rejected candidates come along; its id lives on as an
 * alias. One reading stays one reading: the merged item has one progress.
 */
export function mergeItems(
  db: DB,
  keepId: string,
  otherId: string,
  choices: Record<string, Choice>,
): { operationId: string } {
  return db.transaction(() => {
    const preview = previewMerge(db, keepId, otherId);
    for (const c of preview.conflicts) {
      const v = choices[c.field];
      if (v !== 'keep' && v !== 'other' && !(v === 'both' && c.allowBoth))
        throw new HttpError(400, `Choose which to keep for “${c.label}”.`);
    }
    const before = snapshot(db, [keepId, otherId]);
    const summary = `Merged “${preview.other.title}” into “${preview.keep.title}”`;

    // Owner data: per group, the owner's choice where both have a value, else whichever has one.
    ensureUserRow(db, keepId);
    const a = userRow(db, keepId)!;
    const b = userRow(db, otherId);
    const next: UserRow = { ...a };
    for (const g of GROUPS) {
      if (!hasValue(g.field, b)) continue;
      const take = !hasValue(g.field, a) ? 'other' : (choices[g.field] ?? 'keep');
      if (take === 'other') for (const c of g.cols) next[c] = b![c] ?? null;
      if (take === 'both') {
        const col = g.cols[0]!;
        next[col] = [a[col], b![col]].filter(Boolean).join('\n\n');
      }
    }
    // The shortlist keeps the earlier place of the two.
    const pa = a.shortlist_position as number | null;
    const pb = (b?.shortlist_position as number | null | undefined) ?? null;
    db.prepare('DELETE FROM user_item WHERE item_id = ?').run(otherId);
    next.shortlist_position = pa === null ? pb : pb === null ? pa : Math.min(pa, pb);
    if (pa !== null && pb !== null) {
      // Close the gap the later one leaves.
      const gone = Math.max(pa, pb);
      db.prepare('UPDATE user_item SET shortlist_position = NULL WHERE item_id = ?').run(keepId);
      next.shortlist_position = Math.min(pa, pb);
      const after = db
        .prepare(
          'SELECT item_id FROM user_item WHERE shortlist_position > ? ORDER BY shortlist_position',
        )
        .pluck()
        .all(gone) as string[];
      for (const id of after)
        db.prepare(
          'UPDATE user_item SET shortlist_position = shortlist_position - 1 WHERE item_id = ?',
        ).run(id);
    }
    // A preferred file of the other book is still one of the merged book's files.
    next.updated_at = nowIso();
    const cols = Object.keys(next).filter((k) => k !== 'item_id');
    db.prepare(
      `UPDATE user_item SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE item_id = @item_id`,
    ).run(next);

    // Facts and places.
    db.prepare('UPDATE item_files SET item_id = ?, is_primary = 0 WHERE item_id = ?').run(
      keepId,
      otherId,
    );
    db.prepare('UPDATE locations SET item_id = ? WHERE item_id = ?').run(keepId, otherId);
    db.prepare('UPDATE import_keys SET item_id = ? WHERE item_id = ?').run(keepId, otherId);
    db.prepare('UPDATE store_purchases SET item_id = ? WHERE item_id = ?').run(keepId, otherId);
    db.prepare('UPDATE collection_coverage SET item_id = ? WHERE item_id = ?').run(keepId, otherId);
    db.prepare(
      `INSERT OR IGNORE INTO candidates_rejected (item_id, source, source_id, score, created_at)
       SELECT ?, source, source_id, score, created_at FROM candidates_rejected WHERE item_id = ?`,
    ).run(keepId, otherId);
    // Matches: the kept book's, plus the other's from sources the kept one has none from.
    db.prepare(
      `INSERT OR IGNORE INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
       SELECT ?, source, source_id, score, rank, evidence, data, fetched_at FROM item_matches m
       WHERE m.item_id = ? AND NOT EXISTS (SELECT 1 FROM item_matches k WHERE k.item_id = ? AND k.source = m.source)`,
    ).run(keepId, otherId, keepId);
    // The owner's chosen match must survive even when both entries used the same provider.
    db.prepare(
      `INSERT OR REPLACE INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
       SELECT ?, source, source_id, score, rank, evidence, data, fetched_at FROM item_matches
       WHERE item_id = ? AND source || ':' || source_id = ?`,
    ).run(keepId, otherId, next.match_override ?? null);
    db.prepare(
      `INSERT OR IGNORE INTO lookup_state (item_id, source, version, query, looked_up_at, outcome,
         error, accepted_source_id, rival_source_id, last_answer_at, next_eligible_at, failure_count, manually_selected)
       SELECT ?, source, version, query, looked_up_at, outcome, error, accepted_source_id,
         rival_source_id, last_answer_at, next_eligible_at, failure_count, manually_selected
       FROM lookup_state WHERE item_id = ?`,
    ).run(keepId, otherId);
    db.prepare(
      `UPDATE lookup_state SET manually_selected = 1 WHERE item_id = ? AND source IN
       (SELECT source FROM lookup_state WHERE item_id = ? AND manually_selected = 1)`,
    ).run(keepId, otherId);
    db.prepare('DELETE FROM items WHERE id = ?').run(otherId);
    const now = nowIso();
    db.prepare('UPDATE id_aliases SET new_id = ? WHERE new_id = ?').run(keepId, otherId);
    db.prepare(
      'INSERT OR REPLACE INTO id_aliases (old_id, new_id, created_at) VALUES (?, ?, ?)',
    ).run(otherId, keepId, now);
    db.prepare(
      'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
    ).run('item', otherId, now);
    db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, keepId);
    // Protect the snapshot's series dependencies before the rebuild can remove orphan rows.
    const operationId = record(db, 'merge', summary, before, [keepId]);
    settle(db, [keepId]);
    db.prepare('UPDATE operations SET stamps = ? WHERE id = ?').run(
      JSON.stringify({ [keepId]: stampOf(db, keepId) }),
      operationId,
    );
    return { operationId };
  })();
}

// ---- Split -------------------------------------------------------------------------------------

export interface SplitPreview {
  item: { id: string; title: string };
  stay: { id: string; name: string }[];
  move: { id: string; name: string }[];
  /** What the owner has recorded on the item, which stays or moves as a whole. */
  ownerData: string[];
}

function checkSplit(db: DB, itemId: string, fileIds: string[]) {
  const files = filesOfItem(db, itemId);
  if (files.length === 0) throw new HttpError(404, 'No such item.');
  if (!Array.isArray(fileIds) || fileIds.length === 0)
    throw new HttpError(400, 'Choose the files to split off.');
  for (const f of fileIds)
    if (!files.some((x) => x.id === f)) throw new HttpError(400, 'That file isn’t this book’s.');
  if (fileIds.length >= files.length)
    throw new HttpError(400, 'Leave at least one file with the book.');
  return files;
}

export function previewSplit(db: DB, itemId: string, fileIds: string[]): SplitPreview {
  const files = checkSplit(db, itemId, fileIds);
  const u = userRow(db, itemId);
  return {
    item: { id: itemId, title: titleOf(db, itemId) },
    stay: files.filter((f) => !fileIds.includes(f.id)).map((f) => ({ id: f.id, name: f.name })),
    move: files.filter((f) => fileIds.includes(f.id)).map((f) => ({ id: f.id, name: f.name })),
    ownerData: GROUPS.filter((g) => hasValue(g.field, u)).map(
      (g) => `${g.label}: ${display(g.field, u!)}`,
    ),
  };
}

/**
 * Splits files off into a new item. The owner's data stays with the original, or moves to the
 * new one as a whole — never copied, so a finished reading isn't counted twice.
 */
export function splitItem(
  db: DB,
  itemId: string,
  fileIds: string[],
  ownerData: 'stay' | 'move',
): { operationId: string; newItemId: string } {
  if (ownerData !== 'stay' && ownerData !== 'move')
    throw new HttpError(400, 'Say whether your reading history stays or moves.');
  return db.transaction(() => {
    const files = checkSplit(db, itemId, fileIds);
    const before = snapshot(db, [itemId]);
    const title = titleOf(db, itemId);
    const moving = files.filter((f) => fileIds.includes(f.id));
    db.prepare(`DELETE FROM item_files WHERE file_id IN (${marks(fileIds.length)})`).run(
      ...fileIds,
    );
    const newItemId = createItemForFiles(db, moving);
    if (ownerData === 'move') {
      const match = db
        .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
        .pluck()
        .get(itemId);
      db.prepare(
        `UPDATE item_matches SET item_id = ? WHERE item_id = ? AND source || ':' || source_id = ?`,
      ).run(newItemId, itemId, match ?? null);
      db.prepare('UPDATE candidates_rejected SET item_id = ? WHERE item_id = ?').run(
        newItemId,
        itemId,
      );
      db.prepare('UPDATE import_keys SET item_id = ? WHERE item_id = ?').run(newItemId, itemId);
      db.prepare(
        'UPDATE user_item SET item_id = ?, preferred_file_id = NULL WHERE item_id = ?',
      ).run(newItemId, itemId);
    } else {
      // A chosen file that left with the split no longer belongs here.
      db.prepare(
        `UPDATE user_item SET preferred_file_id = NULL WHERE item_id = ?
           AND preferred_file_id IN (${marks(fileIds.length)})`,
      ).run(itemId, ...fileIds);
    }
    db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(nowIso(), itemId);
    const summary = `Split ${moving.length === 1 ? moving[0]!.name : `${moving.length} files`} off “${title}”`;
    const operationId = record(db, 'split', summary, before, [itemId, newItemId]);
    settle(db, [itemId, newItemId]);
    db.prepare('UPDATE operations SET stamps = ? WHERE id = ?').run(
      JSON.stringify(Object.fromEntries([itemId, newItemId].map((id) => [id, stampOf(db, id)]))),
      operationId,
    );
    return { operationId, newItemId };
  })();
}

// ---- Undo --------------------------------------------------------------------------------------

interface OpRow {
  id: string;
  kind: 'merge' | 'split';
  summary: string;
  before: string;
  item_ids: string;
  stamps: string;
  created_at: string;
  undone_at: string | null;
}

export interface OperationView {
  id: string;
  kind: 'merge' | 'split';
  summary: string;
  createdAt: string;
  undoneAt: string | null;
  canUndo: boolean;
  /** Why not, in plain words. */
  blockedBecause: string | null;
  /** Instead of undo: a split (of a merge) or a merge (of a split), with a preview. */
  instead:
    | { kind: 'split'; itemId: string; fileIds: string[] }
    | { kind: 'merge'; keepId: string; otherId: string }
    | null;
}

function judge(db: DB, op: OpRow, later: OpRow[]): OperationView {
  const ids = parseJson<string[]>(op.item_ids, []);
  const stamps = parseJson<Record<string, string | null>>(op.stamps, {});
  const before = parseJson<Snapshot>(op.before, { ids: [], tables: {}, aliases: [] });
  let blocked: string | null = null;
  if (op.undone_at) blocked = 'Already undone.';
  const touchedLater = later.some(
    (l) =>
      !l.undone_at &&
      [
        ...parseJson<string[]>(l.item_ids, []),
        ...parseJson<Snapshot>(l.before, { ids: [] } as never).ids,
      ].some((i) => ids.includes(i)),
  );
  if (!blocked && touchedLater) blocked = 'A later merge or split changed these books.';
  if (!blocked && ids.some((i) => !db.prepare('SELECT 1 FROM items WHERE id = ?').get(i)))
    blocked = 'One of these books is gone.';
  if (!blocked && ids.some((i) => !stamps[i]?.startsWith('owner-v2:')))
    blocked = 'This older undo record cannot verify later changes. Use the preview instead.';
  if (!blocked && ids.some((i) => stampOf(db, i) !== (stamps[i] ?? null)))
    blocked = 'You’ve changed these books since (progress, rating, notes…). Undo would lose that.';
  let instead: OperationView['instead'] = null;
  if (
    blocked &&
    !op.undone_at &&
    ids.every((i) => db.prepare('SELECT 1 FROM items WHERE id = ?').get(i))
  ) {
    if (op.kind === 'merge') {
      const other = before.ids.find((i) => i !== ids[0]);
      const fileIds = (before.tables.item_files ?? [])
        .filter((r) => r.item_id === other)
        .map((r) => r.file_id as string)
        .filter(
          (f) =>
            db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck().get(f) ===
            ids[0],
        );
      if (fileIds.length) instead = { kind: 'split', itemId: ids[0]!, fileIds };
    } else if (ids.length === 2) instead = { kind: 'merge', keepId: ids[0]!, otherId: ids[1]! };
  }
  return {
    id: op.id,
    kind: op.kind,
    summary: op.summary,
    createdAt: op.created_at,
    undoneAt: op.undone_at,
    canUndo: blocked === null,
    blockedBecause: op.undone_at ? null : blocked,
    instead,
  };
}

/** The last 20 merges and splits, newest first, each with whether it can still be undone. */
export function listOperations(db: DB): OperationView[] {
  const ops = db
    .prepare('SELECT * FROM operations ORDER BY created_at DESC, rowid DESC')
    .all() as OpRow[];
  return ops.map((op, i) => judge(db, op, ops.slice(0, i)));
}

/** Undoes one operation, back to the exact state before it (§11.4, scenario 13). */
export function undoOperation(db: DB, id: string): void {
  db.transaction(() => {
    const view = listOperations(db).find((o) => o.id === id);
    if (!view) throw new HttpError(404, 'That merge or split is no longer in the undo list.');
    if (!view.canUndo) throw new HttpError(409, view.blockedBecause ?? 'It can’t be undone.');
    const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OpRow;
    const snap = parseJson<Snapshot>(op.before, { ids: [], tables: {}, aliases: [] });
    const after = parseJson<string[]>(op.item_ids, []);
    restore(db, snap, after);
    db.prepare('UPDATE operations SET undone_at = ? WHERE id = ?').run(nowIso(), id);
    markObsoleteReviews(db);
    syncSeries(db);
  })();
}
