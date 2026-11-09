import type { DB } from '../db/database.ts';
import { attachFiles, createItemForFiles, type FileFacts } from './items.ts';

/**
 * Grouping by name and size (PLAN.md §11.3 rules 1–2, M1 level). Runs over every file that
 * isn't on an item yet, so links chain: book.epub + book.pdf on the drive and copies of both
 * elsewhere all end up on one item.
 *
 *  1. Copies: same filename (extension included, ignoring case) and exact same size, in
 *     different directories, with no disagreeing hash. This also carries history across a
 *     move: a file that went missing and reappears elsewhere joins the same item (§9.3).
 *  2. Format group: same folder + directory + base name (quality tags removed), different
 *     format or quality, and no *known* conflict (language, abridgment, edition number).
 *
 * Cautious: if a new file links to two different existing items, nothing is merged; it gets
 * an item of its own (the review queue arrives in M3).
 */

function hashesDisagree(a: FileFacts, b: FileFacts): boolean {
  if (a.full_hash && b.full_hash && a.full_hash !== b.full_hash) return true;
  if (a.partial_hash && b.partial_hash && a.partial_hash !== b.partial_hash) return true;
  return false;
}

export function knownConflict(a: FileFacts, b: FileFacts): boolean {
  if (a.language && b.language && a.language !== b.language) return true;
  if (a.abridged !== null && b.abridged !== null && a.abridged !== b.abridged) return true;
  if (
    a.edition_number !== null &&
    b.edition_number !== null &&
    a.edition_number !== b.edition_number
  )
    return true;
  return false;
}

export function areCopies(a: FileFacts, b: FileFacts): boolean {
  return (
    a.id !== b.id &&
    a.size > 0 && // empty files all "match" each other; they say nothing
    a.size === b.size &&
    a.name.toLowerCase() === b.name.toLowerCase() &&
    (a.folder_id !== b.folder_id || a.rel_dir !== b.rel_dir) &&
    !hashesDisagree(a, b)
  );
}

export function sameFormatGroup(a: FileFacts, b: FileFacts): boolean {
  return (
    a.id !== b.id &&
    a.folder_id === b.folder_id &&
    a.rel_dir === b.rel_dir &&
    a.compare_key === b.compare_key &&
    (a.format !== b.format || (a.quality_tag ?? '') !== (b.quality_tag ?? '')) &&
    !knownConflict(a, b)
  );
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface GroupingResult {
  itemsCreated: number;
  filesAttached: number;
  ambiguous: number;
}

export function groupUnassignedFiles(db: DB): GroupingResult {
  const unassigned = db
    .prepare(
      'SELECT f.* FROM files f WHERE NOT EXISTS (SELECT 1 FROM item_files x WHERE x.file_id = f.id)',
    )
    .all() as FileFacts[];
  const result: GroupingResult = { itemsCreated: 0, filesAttached: 0, ambiguous: 0 };
  if (unassigned.length === 0) return result;

  const byNameSize = db.prepare(
    `SELECT f.*, x.item_id FROM files f LEFT JOIN item_files x ON x.file_id = f.id
     WHERE f.name = ? COLLATE NOCASE AND f.size = ?`,
  );
  const siblings = db.prepare(
    `SELECT f.*, x.item_id FROM files f LEFT JOIN item_files x ON x.file_id = f.id
     WHERE f.folder_id = ? AND f.rel_dir = ? AND f.compare_key = ?`,
  );

  const uf = new UnionFind();
  /** file id -> existing items it links to */
  const links = new Map<string, Set<string>>();
  const link = (fileId: string, itemId: string) => {
    if (!links.has(fileId)) links.set(fileId, new Set());
    links.get(fileId)!.add(itemId);
  };

  for (const f of unassigned) {
    for (const other of byNameSize.all(f.name, f.size) as (FileFacts & {
      item_id: string | null;
    })[]) {
      if (!areCopies(f, other)) continue;
      if (other.item_id) link(f.id, other.item_id);
      else uf.union(f.id, other.id);
    }
    for (const other of siblings.all(f.folder_id, f.rel_dir, f.compare_key) as (FileFacts & {
      item_id: string | null;
    })[]) {
      if (!sameFormatGroup(f, other)) continue;
      if (other.item_id) link(f.id, other.item_id);
      else uf.union(f.id, other.id);
    }
  }

  const components = new Map<string, FileFacts[]>();
  for (const f of unassigned) {
    const root = uf.find(f.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(f);
  }

  for (const files of components.values()) {
    const items = new Set<string>();
    for (const f of files) for (const i of links.get(f.id) ?? []) items.add(i);
    if (items.size === 1) {
      attachFiles(db, [...items][0]!, files);
      result.filesAttached += files.length;
    } else {
      if (items.size > 1) result.ambiguous++;
      createItemForFiles(db, files);
      result.itemsCreated++;
    }
  }
  return result;
}
