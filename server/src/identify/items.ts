import type { DB } from '../db/database.ts';
import { newId, nowIso, parseJson } from '../util.ts';
import { titleCase, type ParsedName } from './filename.ts';

/** Facts about one file needed to group it and pick a primary (subset of a `files` row). */
export interface FileFacts {
  id: string;
  folder_id: string;
  rel_dir: string;
  name: string;
  format: string;
  size: number;
  availability: string;
  partial_hash: string | null;
  full_hash: string | null;
  quality_tag: string | null;
  edition_number: number | null;
  language: string | null;
  abridged: number | null;
  compare_key: string;
  rel_path: string;
  parsed: string;
}

const COMIC_FORMATS = new Set(['cbz', 'cbr', 'cb7']);

/** Display title from the filename parse. All-lowercase slugs get title case for display only. */
export function displayTitle(p: ParsedName): string {
  let t: string;
  const series = p.series?.value;
  if (series && p.issue) {
    t = `${series}${p.seriesVolume && !p.seriesVolume.value.startsWith('season') ? ` v${p.seriesVolume.value}` : ''} #${p.issue.value}`;
  } else if (series && p.volume) {
    t = `${series} Vol. ${p.volume.value}${p.subtitle ? `: ${p.subtitle.value}` : ''}`;
  } else {
    t = p.title.value + (p.subtitle && !series ? `: ${p.subtitle.value}` : '');
  }
  return t === t.toLowerCase() ? titleCase(t) : t;
}

/**
 * Kind from what the files alone can say. Comic archives are comics; nothing else is known
 * until sources are looked up (M3), so it stays unknown (null) rather than a guess (§4).
 */
export function kindFromFiles(files: FileFacts[]): { kind: string | null; source: string | null } {
  if (files.length > 0 && files.every((f) => COMIC_FORMATS.has(f.format))) return { kind: 'comic', source: 'format' };
  return { kind: null, source: null };
}

const AVAILABILITY_RANK: Record<string, number> = { present: 0, placeholder: 1, unknown: 2, missing: 3 };
const PROSE_FORMAT_RANK: Record<string, number> = { epub: 0, pdf: 1, mobi: 2, azw3: 3, cbz: 4, cbr: 5, cb7: 6 };
const COMIC_FORMAT_RANK: Record<string, number> = { cbz: 0, cbr: 1, cb7: 2, pdf: 3, epub: 4, mobi: 5, azw3: 6 };

/**
 * Primary file (what Open uses and whose length counts, §11.3): a present file before a
 * placeholder before a missing one; then EPUB for prose, the HD version for comics, then other
 * formats. Ties break on the shortest path so the choice is stable.
 */
export function choosePrimary(files: FileFacts[], kind: string | null): FileFacts | undefined {
  const comic = kind === 'comic' || kind === 'manga';
  const fmtRank = comic ? COMIC_FORMAT_RANK : PROSE_FORMAT_RANK;
  return [...files].sort(
    (a, b) =>
      (AVAILABILITY_RANK[a.availability] ?? 9) - (AVAILABILITY_RANK[b.availability] ?? 9) ||
      (comic ? Number(Boolean(b.quality_tag)) - Number(Boolean(a.quality_tag)) : 0) ||
      (fmtRank[a.format] ?? 9) - (fmtRank[b.format] ?? 9) ||
      a.rel_path.length - b.rel_path.length ||
      a.id.localeCompare(b.id),
  )[0];
}

export function createItemForFiles(db: DB, files: FileFacts[]): string {
  const { kind, source } = kindFromFiles(files);
  const primary = choosePrimary(files, kind)!;
  const p = parseJson<ParsedName | null>(primary.parsed, null);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO items (id, kind, kind_source, title, series_hint, volume_label, issue_label,
       publication_year, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    source,
    p ? displayTitle(p) : primary.name,
    p?.series?.value ?? null,
    p?.volume?.value ?? null,
    p?.issue?.value ?? null,
    null, // a year in a filename is the edition's or issue's, not first publication: unknown
    now,
    now,
  );
  const ins = db.prepare('INSERT INTO item_files (item_id, file_id, is_primary) VALUES (?, ?, 0)');
  for (const f of files) ins.run(id, f.id);
  refreshPrimary(db, id);
  return id;
}

export function attachFiles(db: DB, itemId: string, files: FileFacts[]): void {
  const ins = db.prepare('INSERT INTO item_files (item_id, file_id, is_primary) VALUES (?, ?, 0)');
  for (const f of files) ins.run(itemId, f.id);
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(nowIso(), itemId);
  refreshPrimary(db, itemId);
}

export function filesOfItem(db: DB, itemId: string): FileFacts[] {
  return db
    .prepare(
      `SELECT f.* FROM files f JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ?`,
    )
    .all(itemId) as FileFacts[];
}

export function refreshPrimary(db: DB, itemId: string): void {
  const item = db.prepare('SELECT kind FROM items WHERE id = ?').get(itemId) as { kind: string | null } | undefined;
  if (!item) return;
  const primary = choosePrimary(filesOfItem(db, itemId), item.kind);
  db.prepare('UPDATE item_files SET is_primary = CASE WHEN file_id = ? THEN 1 ELSE 0 END WHERE item_id = ?').run(
    primary?.id ?? null,
    itemId,
  );
}

export function refreshAllPrimaries(db: DB): void {
  const ids = db.prepare('SELECT id FROM items').pluck().all() as string[];
  for (const id of ids) refreshPrimary(db, id);
}

/** Does the owner have anything recorded on this item? (Then it is never silently deleted.) */
export function hasOwnerData(db: DB, itemId: string): boolean {
  const u = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(itemId) as Record<string, unknown> | undefined;
  const loc = db.prepare('SELECT 1 FROM locations WHERE item_id = ? LIMIT 1').get(itemId);
  if (loc) return true;
  if (!u) return false;
  const defaults: Record<string, unknown> = { progress: 'not_started', hidden: 0 };
  return Object.entries(u).some(
    ([k, v]) => !['item_id', 'updated_at'].includes(k) && v !== null && v !== (defaults[k] ?? null),
  );
}

/** Removes items with no files and no owner data (e.g. after a folder is removed). */
export function removeOrphanItems(db: DB): number {
  const orphans = db
    .prepare('SELECT id FROM items i WHERE NOT EXISTS (SELECT 1 FROM item_files x WHERE x.item_id = i.id)')
    .pluck()
    .all() as string[];
  let removed = 0;
  const now = nowIso();
  for (const id of orphans) {
    if (hasOwnerData(db, id)) continue;
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)').run('item', id, now);
    removed++;
  }
  return removed;
}
