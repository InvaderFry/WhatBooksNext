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
      db.prepare('UPDATE folders SET last_letter = ?, updated_at = ? WHERE id = ?').run(letter, nowIso(), folder.id);
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

export async function addFolder(
  db: DB,
  platform: Platform,
  input: { path: string; dataDir?: string },
): Promise<FolderRow> {
  const raw = (input.path ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new HttpError(400, 'Enter a folder path.');
  if (!path.isAbsolute(raw)) throw new HttpError(400, 'Enter a full path, such as E:\\Books.');
  const abs = path.resolve(raw);
  if (!isDirectory(abs)) throw new HttpError(400, "That folder can't be found. Is the drive connected?");
  if (input.dataDir && (abs === input.dataDir || abs.startsWith(input.dataDir + path.sep))) {
    throw new HttpError(400, "That's the app's own data folder.");
  }
  const existing = db.prepare('SELECT * FROM folders').all() as FolderRow[];
  for (const f of existing) {
    if (path.resolve(f.display_path).toLowerCase() === abs.toLowerCase()) {
      throw new HttpError(409, 'That folder is already in the library.');
    }
  }
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
): Promise<FolderRow> {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
  if (!folder) throw new HttpError(404, 'No such folder.');
  const abs = path.resolve(newPath.trim().replace(/^"(.*)"$/, '$1'));
  if (!isDirectory(abs)) throw new HttpError(400, "That folder can't be found.");
  const vol = await platform.describeVolume(abs);
  db.prepare(
    `UPDATE folders SET display_path = ?, volume_id = ?, volume_serial = ?, volume_label = ?,
       relative_path = ?, last_letter = ?, storage_kind = ?, updated_at = ? WHERE id = ?`,
  ).run(abs, vol.volumeId, vol.serial, vol.label, vol.relativePath, vol.letter, vol.storageKind, nowIso(), folderId);
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow;
}
