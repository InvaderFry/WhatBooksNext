import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/database.ts';
import type { Platform } from '../platform/types.ts';
import { HttpError, newId, nowIso } from '../util.ts';

export interface FolderRow {
  id: string;
  display_path: string;
  volume_id: string | null;
  volume_serial: string | null;
  volume_label: string | null;
  relative_path: string;
  last_letter: string | null;
  storage_kind: 'local' | 'external' | 'cloud';
  also_in_icloud: number;
  last_seen_at: string | null;
  last_complete_scan_at: string | null;
  /** When the folder's first scan completed: books first seen after it are new arrivals. */
  first_complete_scan_at: string | null;
  reminder_snoozed_until?: string | null;
  created_at: string;
  updated_at: string;
}

/** Joins a stored '/'-separated relative path onto an absolute root with native separators. */
export function joinRel(root: string, rel: string): string {
  return rel ? path.join(root, ...rel.split('/')) : root;
}

/**
 * Where the folder is now (§9.4). With a volume identity, the volume is looked up wherever it
 * is mounted — a drive that moved from E: to F: is still found. Without one, the stored path
 * is used. Null means unreachable: skipped and reported, never treated as empty (§9.3).
 */
export async function resolveFolderRoot(
  db: DB,
  platform: Platform,
  folder: FolderRow,
): Promise<string | null> {
  if (folder.volume_id) {
    const root = await platform.findVolumeRoot(folder.volume_id);
    if (!root) return null;
    const abs = path.join(root, folder.relative_path);
    if (!isDirectory(abs)) return null;
    const letter = /^([A-Za-z]):/.exec(root)?.[1]?.toUpperCase() ?? null;
    if (letter && letter !== folder.last_letter) {
      db.prepare('UPDATE folders SET last_letter = ?, updated_at = ? WHERE id = ?').run(
        letter,
        nowIso(),
        folder.id,
      );
    }
    return abs;
  }
  return isDirectory(folder.display_path) ? folder.display_path : null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * How folder `a` sits against folder `b`: the same folder, inside it, containing it, or apart.
 * Compared without regard to case (Windows paths) and on whole segments, so `E:\Books2` is not
 * inside `E:\Books`.
 */
export function pathRelation(a: string, b: string): 'same' | 'inside' | 'contains' | null {
  const key = (p: string) => {
    const r = path.resolve(p).toLowerCase();
    return r.endsWith(path.sep) ? r : r + path.sep;
  };
  const [ka, kb] = [key(a), key(b)];
  if (ka === kb) return 'same';
  if (ka.startsWith(kb)) return 'inside';
  if (kb.startsWith(ka)) return 'contains';
  return null;
}

/**
 * The one check for a folder path the owner typed, for Add and for Reconnect: a full path that
 * exists, not the app's data folder, and not the same as, inside or around another library
 * folder (`exceptId` is the folder being reconnected). Returns the resolved path.
 */
export function checkFolderPath(
  db: DB,
  input: string,
  opts: { dataDir?: string; exceptId?: string } = {},
): string {
  const raw = (input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new HttpError(400, 'Enter a folder path.');
  if (!path.isAbsolute(raw)) throw new HttpError(400, 'Enter a full path, such as E:\\Books.');
  const abs = path.resolve(raw);
  if (!isDirectory(abs))
    throw new HttpError(400, "That folder can't be found. Is the drive connected?");
  if (opts.dataDir) {
    const rel = pathRelation(abs, opts.dataDir);
    if (rel === 'same' || rel === 'inside')
      throw new HttpError(400, "That's the app's own data folder.");
    if (rel === 'contains')
      throw new HttpError(400, `That folder holds the app's own data folder (${opts.dataDir}).`);
  }
  const existing = db.prepare('SELECT id, display_path FROM folders').all() as {
    id: string;
    display_path: string;
  }[];
  for (const f of existing) {
    if (f.id === opts.exceptId) continue;
    const rel = pathRelation(abs, f.display_path);
    if (rel === 'same') throw new HttpError(409, 'That folder is already in the library.');
    if (rel === 'inside')
      throw new HttpError(
        409,
        `That folder is inside ${f.display_path}, which is already in the library, so its books are already listed.`,
      );
    if (rel === 'contains')
      throw new HttpError(
        409,
        `That folder holds ${f.display_path}, which is already in the library. One library folder can't be inside another: its books would be listed twice.`,
      );
  }
  return abs;
}

/** Library folders that are inside another one: added before the check above existed (D4). */
export function nestedFolders(db: DB): { inner: string; outer: string }[] {
  const all = db
    .prepare('SELECT display_path FROM folders ORDER BY display_path')
    .pluck()
    .all() as string[];
  const out: { inner: string; outer: string }[] = [];
  for (const inner of all)
    for (const outer of all)
      if (inner !== outer && pathRelation(inner, outer) === 'inside') out.push({ inner, outer });
  return out;
}

export async function addFolder(
  db: DB,
  platform: Platform,
  input: { path: string; dataDir?: string },
): Promise<FolderRow> {
  const abs = checkFolderPath(db, input.path, { dataDir: input.dataDir });
  const vol = await platform.describeVolume(abs);
  const now = nowIso();
  const row: FolderRow = {
    id: newId(),
    display_path: abs,
    volume_id: vol.volumeId,
    volume_serial: vol.serial,
    volume_label: vol.label,
    relative_path: vol.relativePath,
    last_letter: vol.letter,
    storage_kind: vol.storageKind,
    also_in_icloud: 0,
    last_seen_at: now,
    last_complete_scan_at: null,
    first_complete_scan_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO folders (id, display_path, volume_id, volume_serial, volume_label, relative_path,
      last_letter, storage_kind, also_in_icloud, last_seen_at, last_complete_scan_at, created_at, updated_at)
     VALUES (@id, @display_path, @volume_id, @volume_serial, @volume_label, @relative_path,
      @last_letter, @storage_kind, @also_in_icloud, @last_seen_at, @last_complete_scan_at, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

/**
 * "Reconnect this folder" (§9.4): the owner points an existing folder at where it is now.
 * Files keep their ids and history; the next scan matches them by relative path.
 */
export async function reconnectFolder(
  db: DB,
  platform: Platform,
  folderId: string,
  newPath: string,
  dataDir?: string,
): Promise<FolderRow> {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as
    FolderRow | undefined;
  if (!folder) throw new HttpError(404, 'No such folder.');
  const abs = checkFolderPath(db, newPath, { dataDir, exceptId: folderId });
  const vol = await platform.describeVolume(abs);
  db.prepare(
    `UPDATE folders SET display_path = ?, volume_id = ?, volume_serial = ?, volume_label = ?,
       relative_path = ?, last_letter = ?, storage_kind = ?, updated_at = ? WHERE id = ?`,
  ).run(
    abs,
    vol.volumeId,
    vol.serial,
    vol.label,
    vol.relativePath,
    vol.letter,
    vol.storageKind,
    nowIso(),
    folderId,
  );
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow;
}
