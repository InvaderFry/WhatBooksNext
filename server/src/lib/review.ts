import type { DB } from '../db/database.ts';
import {
  createItemForFiles,
  filesOfItem,
  hasOwnerData,
  mergeInto,
  refreshFactsOfItems,
  refreshPrimary,
} from '../identify/items.ts';
import { markObsoleteReviews } from '../identify/reconcile.ts';
import { hiddenReviewKeys, identityRows, type CandidateView } from './identityReview.ts';
import { HttpError, nowIso, parseJson } from '../util.ts';
import { syncSeries } from '../identify/series.ts';

/**
 * Needs review (PLAN.md §11.4), as far as M2 goes: what the deep pass finds — candidate moves,
 * groups whose files conflict, the same file on two items with history (tier 1) — and
 * cross-folder suggestions and uncertain PDF types (tier 4). Tiers 2–3, search, Defer and
 * Dismiss arrive with the sources in M3; merging two items' history needs the M4 preview.
 */

export interface ReviewFile {
  id: string;
  name: string;
  folderPath: string;
  relPath: string;
  format: string;
  size: number;
  availability: string;
}

export interface ReviewItemRef {
  id: string;
  title: string;
  hasHistory: boolean;
}

export interface ReviewRow {
  id: string;
  kind:
    | 'move'
    | 'group_conflict'
    | 'copy_conflict'
    | 'cross_folder'
    | 'pdf_type'
    | 'tie'
    | 'wrong_match'
    | 'unidentified'
    | 'provisional';
  tier: number;
  why: string;
  items: ReviewItemRef[];
  files: ReviewFile[];
  /** What the owner can do with this row (file rows; identity rows act on the item). */
  actions: ('accept' | 'decline' | 'split')[];
  /** Identity rows: the candidates to choose from, best first. */
  candidates?: CandidateView[];
}

/** Tier 4 is collapsed and can be long: identity rows there are capped, with a count of the rest. */
const TIER4_IDENTITY_ROWS = 100;

export interface ReviewList {
  tiers: Record<number, number>;
  rows: ReviewRow[];
  /** Rows not listed: identity rows past the tier-4 cap, and unidentified items that can wait. */
  notListed: { provisional: number; unidentified: number };
  hidden: number;
}

const TITLE = `SELECT COALESCE(u.title_override, i.title) FROM items i
  LEFT JOIN user_item u ON u.item_id = i.id WHERE i.id = ?`;

export function listReview(db: DB): ReviewList {
  const title = db.prepare(TITLE).pluck();
  const fileRow = db.prepare(
    `SELECT f.id, f.name, f.rel_path, f.format, f.size, f.availability, d.display_path
     FROM files f JOIN folders d ON d.id = f.folder_id WHERE f.id = ?`,
  );
  const toFile = (id: string): ReviewFile | null => {
    const f = fileRow.get(id) as
      | {
          id: string;
          name: string;
          rel_path: string;
          format: string;
          size: number;
          availability: string;
          display_path: string;
        }
      | undefined;
    return f
      ? {
          id: f.id,
          name: f.name,
          folderPath: f.display_path,
          relPath: f.rel_path,
          format: f.format,
          size: f.size,
          availability: f.availability,
        }
      : null;
  };
  const toItem = (id: string): ReviewItemRef | null => {
    const t = title.get(id) as string | undefined;
    return t === undefined ? null : { id, title: t, hasHistory: hasOwnerData(db, id) };
  };

  const rows: ReviewRow[] = [];
  for (const r of db
    .prepare("SELECT * FROM review_items WHERE status = 'open' ORDER BY tier, created_at")
    .all() as {
    id: string;
    kind: ReviewRow['kind'];
    tier: number;
    item_ids: string;
    file_ids: string;
    detail: string;
  }[]) {
    const items = parseJson<string[]>(r.item_ids, [])
      .map(toItem)
      .filter((x): x is ReviewItemRef => !!x);
    const files = parseJson<string[]>(r.file_ids, [])
      .map(toFile)
      .filter((x): x is ReviewFile => !!x);
    const actions: ReviewRow['actions'] =
      r.kind === 'group_conflict'
        ? ['split', 'decline']
        : r.kind === 'copy_conflict'
          ? ['decline']
          : ['accept', 'decline'];
    rows.push({
      id: r.id,
      kind: r.kind,
      tier: r.tier,
      why: parseJson<{ why?: string }>(r.detail, {}).why ?? '',
      items,
      files,
      actions,
    });
  }

  // Uncertain PDF types (tier 4): computed, not stored — fixing the type removes the row.
  for (const f of db
    .prepare(
      `SELECT f.id, f.pdf_type_evidence, x.item_id FROM files f
       JOIN item_files x ON x.file_id = f.id LEFT JOIN file_user u ON u.file_id = f.id
       WHERE f.pdf_type = 'uncertain' AND u.pdf_type_override IS NULL ORDER BY f.name`,
    )
    .all() as { id: string; pdf_type_evidence: string | null; item_id: string }[]) {
    const item = toItem(f.item_id);
    const file = toFile(f.id);
    if (!item || !file) continue;
    rows.push({
      id: `pdf:${f.id}`,
      kind: 'pdf_type',
      tier: 4,
      why: f.pdf_type_evidence ?? 'The PDF type is uncertain.',
      items: [item],
      files: [file],
      actions: [],
    });
  }
  // Identities (M3): ties and wrong matches, then what matters now, then the rest.
  const ids = identityRows(db);
  let tier4Identity = 0;
  let provisionalNotListed = 0;
  for (const r of ids.rows) {
    if (r.tier === 4 && ++tier4Identity > TIER4_IDENTITY_ROWS) {
      provisionalNotListed++;
      continue;
    }
    rows.push({
      id: r.id,
      kind: r.kind,
      tier: r.tier,
      why: r.why,
      items: [{ id: r.itemId, title: r.title, hasHistory: r.hasHistory }],
      files: [],
      actions: [],
      candidates: r.candidates,
    });
  }

  // Deferred (until their date) and dismissed rows are left out (§11.4).
  const hiddenKeys = hiddenReviewKeys(db);
  const visible = rows.filter((r) => !hiddenKeys.has(r.id));
  const tiers: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of visible) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
  visible.sort((a, b) => a.tier - b.tier);
  return {
    tiers,
    rows: visible,
    notListed: { provisional: provisionalNotListed, unidentified: ids.unidentifiedOther },
    hidden: rows.length - visible.length,
  };
}

/** The count shown in the menu: everything listed, as on the page. */
export function openReviewCount(db: DB): number {
  return listReview(db).rows.length;
}

/**
 * "Confirm all like this" (§11.4): every open row of one kind at once. The preview lists what
 * would happen; rows that can't be done automatically (both items have history) are skipped
 * and reported, never forced.
 */
export function bulkReview(
  db: DB,
  kind: 'cross_folder' | 'move',
  action: 'accept' | 'decline',
  preview: boolean,
): { total: number; done: number; skipped: { id: string; reason: string }[]; sample: string[] } {
  const rows = listReview(db).rows.filter((r) => r.kind === kind);
  const skipped: { id: string; reason: string }[] = [];
  const sample = rows.slice(0, 10).map((r) => r.items.map((i) => i.title).join(' + '));
  let done = 0;
  for (const r of rows) {
    const blocked = action === 'accept' && r.items.filter((i) => i.hasHistory).length > 1;
    if (blocked) {
      skipped.push({ id: r.id, reason: 'both have reading history' });
      continue;
    }
    if (preview) {
      done++;
      continue;
    }
    try {
      db.transaction(() => actOnReview(db, r.id, action))();
      done++;
    } catch (e) {
      skipped.push({ id: r.id, reason: (e as Error).message });
    }
  }
  return { total: rows.length, done, skipped, sample };
}

/** Merges two items where at most one has history: the other joins it. */
function mergePair(db: DB, a: string, b: string): string {
  const aHas = hasOwnerData(db, a);
  const bHas = hasOwnerData(db, b);
  if (aHas && bHas)
    throw new HttpError(
      409,
      'Both have reading history. Merging history needs a preview of the conflicts, which comes in a later version.',
    );
  const keep = bHas ? b : a;
  mergeInto(db, keep === a ? b : a, keep);
  return keep;
}

export function actOnReview(
  db: DB,
  id: string,
  action: 'accept' | 'decline' | 'split',
  fileId?: string,
): void {
  const r = db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as
    { id: string; kind: string; status: string; item_ids: string; file_ids: string } | undefined;
  if (!r) throw new HttpError(404, 'No such review row.');
  if (r.status !== 'open') throw new HttpError(409, 'That has already been decided.');
  const fileIds = parseJson<string[]>(r.file_ids, []);
  const itemOf = db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
  const touched: string[] = [];

  if (action === 'accept') {
    if (r.kind !== 'move' && r.kind !== 'cross_folder')
      throw new HttpError(400, 'That row can’t be accepted.');
    const [a, b] = fileIds.map((f) => itemOf.get(f) as string | undefined);
    if (!a || !b) throw new HttpError(409, 'The files have changed since; scan again.');
    if (a !== b) touched.push(r.kind === 'move' ? mergeMove(db, a, b) : mergePair(db, a, b));
  } else if (action === 'split') {
    if (r.kind !== 'group_conflict') throw new HttpError(400, 'Only a group can be split.');
    if (!fileId || !fileIds.includes(fileId))
      throw new HttpError(400, 'Say which file to split off.');
    const itemId = itemOf.get(fileId) as string | undefined;
    if (!itemId) throw new HttpError(409, 'The file has changed since; scan again.');
    if (filesOfItem(db, itemId).length < 2) throw new HttpError(409, 'It is already on its own.');
    // The split-off file becomes its own item; the history stays where it is.
    const file = filesOfItem(db, itemId).find((f) => f.id === fileId)!;
    db.prepare('DELETE FROM item_files WHERE file_id = ?').run(fileId);
    refreshPrimary(db, itemId);
    touched.push(itemId, createItemForFiles(db, [file]));
  }
  db.prepare('UPDATE review_items SET status = ?, updated_at = ? WHERE id = ?').run(
    action === 'decline' ? 'declined' : 'accepted',
    nowIso(),
    id,
  );
  refreshFactsOfItems(db, touched);
  markObsoleteReviews(db);
  syncSeries(db);
}

/** A confirmed move: the missing file's item (with the history) takes the new file's item. */
function mergeMove(db: DB, missingItem: string, newItem: string): string {
  if (hasOwnerData(db, newItem))
    throw new HttpError(
      409,
      'The new file has its own reading history. Merging history needs a preview of the conflicts, which comes in a later version.',
    );
  mergeInto(db, newItem, missingItem);
  return missingItem;
}
