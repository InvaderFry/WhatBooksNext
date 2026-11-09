import path from 'node:path';
import { EXTENSION_FORMATS, MAX_SCAN_DEPTH } from '../config.ts';
import type { DB } from '../db/database.ts';
import { parseFilename } from '../identify/filename.ts';
import { availabilityFromAttributes, type Platform } from '../platform/types.ts';
import { newId, nowIso } from '../util.ts';
import { resolveFolderRoot, type FolderRow } from './folders.ts';

/**
 * The light pass (PLAN.md §9.2): lists every reachable folder and records names, paths, sizes,
 * dates and availability without reading file contents. The filename parser runs here.
 *
 * Missing files (§9.3): a file becomes `missing` only if its own directory was completely
 * listed in this scan and the file wasn't there — or an ancestor was completely listed and the
 * directory itself is gone. Anything in a directory that wasn't listed (access error, drive
 * unplugged mid-scan, cancel) is left exactly as it was and flagged `stale`.
 */

export interface CancelToken {
  cancelled: boolean;
}

export interface FolderScanSummary {
  folderId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'unreachable';
  dirsListed: number;
  dirErrors: number;
  linksSkipped: number;
  filesSeen: number;
  newFiles: number;
  missing: number;
  stale: number;
  returned: number;
  ignoredByType: Record<string, number>;
}

export interface FoundFile {
  relPath: string;
  relDir: string;
  name: string;
  ext: string;
  format: string;
  size: number;
  modifiedMs: number | null;
  createdMs: number | null;
  attributes: number | null;
  availability: 'present' | 'placeholder' | 'unknown';
}

interface ExistingFile {
  id: string;
  rel_path: string;
  rel_dir: string;
  size: number;
  modified_ms: number | null;
  availability: string;
  stale: number;
}

export function formatForName(name: string): { ext: string; format: string } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const format = EXTENSION_FORMATS[ext];
  return format ? { ext, format } : null;
}

function parentDir(rel: string): string | null {
  if (rel === '') return null;
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export async function lightScanFolder(
  db: DB,
  platform: Platform,
  folder: FolderRow,
  cancel: CancelToken,
  onProgress?: (s: FolderScanSummary) => void,
): Promise<FolderScanSummary> {
  const summary: FolderScanSummary = {
    folderId: folder.id,
    status: 'completed',
    dirsListed: 0,
    dirErrors: 0,
    linksSkipped: 0,
    filesSeen: 0,
    newFiles: 0,
    missing: 0,
    stale: 0,
    returned: 0,
    ignoredByType: {},
  };

  const root = await resolveFolderRoot(db, platform, folder);
  if (!root) {
    summary.status = 'unreachable';
    return summary;
  }

  const found: FoundFile[] = [];
  const completeDirs = new Set<string>();
  /** directory -> lowercase names of its child directories, as listed */
  const childDirs = new Map<string, Set<string>>();
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];

  while (stack.length > 0) {
    if (cancel.cancelled) {
      summary.status = 'cancelled';
      break;
    }
    const { abs, rel, depth } = stack.pop()!;
    let entries;
    try {
      entries = await platform.listDirectory(abs);
    } catch {
      summary.dirErrors++;
      continue; // not completely listed: its files stay as they were
    }
    completeDirs.add(rel);
    summary.dirsListed++;
    const children = new Set<string>();
    childDirs.set(rel, children);
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        children.add(e.name.toLowerCase());
        if (e.isLink) {
          summary.linksSkipped++;
          continue;
        }
        if (depth + 1 > MAX_SCAN_DEPTH) continue;
        stack.push({ abs: path.join(abs, e.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      if (e.isLink) continue;
      const fmt = formatForName(e.name);
      if (!fmt) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '(none)';
        summary.ignoredByType[ext] = (summary.ignoredByType[ext] ?? 0) + 1;
        continue;
      }
      found.push({
        relPath: childRel,
        relDir: rel,
        name: e.name,
        ext: fmt.ext,
        format: fmt.format,
        size: e.size,
        modifiedMs: e.modifiedMs,
        createdMs: e.createdMs,
        attributes: e.attributes,
        availability: platform.supportsPlaceholders ? availabilityFromAttributes(e.attributes) : 'present',
      });
    }
    summary.filesSeen = found.length;
    onProgress?.(summary);
  }
  if (summary.status !== 'cancelled' && summary.dirErrors > 0) summary.status = 'partial';

  applyFolderListing(db, folder, found, completeDirs, childDirs, summary);
  return summary;
}

/** Writes one folder's listing to the database in a single transaction. */
export function applyFolderListing(
  db: DB,
  folder: FolderRow,
  found: FoundFile[],
  completeDirs: Set<string>,
  childDirs: Map<string, Set<string>>,
  summary: FolderScanSummary,
): void {
  const now = nowIso();
  const existing = db
    .prepare('SELECT id, rel_path, rel_dir, size, modified_ms, availability, stale FROM files WHERE folder_id = ?')
    .all(folder.id) as ExistingFile[];
  // Windows paths are case-insensitive; a rename that only changes case is the same file.
  const byPath = new Map(existing.map((f) => [f.rel_path.toLowerCase(), f]));
  const seen = new Set<string>();

  const insert = db.prepare(
    `INSERT INTO files (id, folder_id, rel_path, rel_dir, name, ext, format, size, created_ms, modified_ms,
       availability, stale, attributes, parsed, compare_key, quality_tag, edition_number, edition_note,
       first_seen_at, last_seen_at)
     VALUES (@id, @folder_id, @rel_path, @rel_dir, @name, @ext, @format, @size, @created_ms, @modified_ms,
       @availability, 0, @attributes, @parsed, @compare_key, @quality_tag, @edition_number, @edition_note,
       @now, @now)`,
  );
  const update = db.prepare(
    `UPDATE files SET rel_path = @rel_path, rel_dir = @rel_dir, name = @name, size = @size,
       created_ms = @created_ms, modified_ms = @modified_ms, availability = @availability, stale = 0,
       attributes = @attributes, last_seen_at = @now,
       stages = CASE WHEN @reset THEN '{}' ELSE stages END,
       partial_hash = CASE WHEN @changed THEN NULL ELSE partial_hash END,
       full_hash = CASE WHEN @changed THEN NULL ELSE full_hash END
     WHERE id = @id`,
  );
  const markMissing = db.prepare("UPDATE files SET availability = 'missing', stale = 0 WHERE id = ?");
  const markStale = db.prepare('UPDATE files SET stale = 1 WHERE id = ?');
  const dirScan = db.prepare(
    'INSERT INTO directory_scans (folder_id, rel_dir, listed_at) VALUES (?, ?, ?) ON CONFLICT (folder_id, rel_dir) DO UPDATE SET listed_at = excluded.listed_at',
  );

  db.transaction(() => {
    for (const f of found) {
      const key = f.relPath.toLowerCase();
      seen.add(key);
      const old = byPath.get(key);
      if (old) {
        const changed = old.size !== f.size || old.modified_ms !== f.modifiedMs;
        // A placeholder that has been downloaded gets a deep pass even if size/date are the same (§9.2).
        const becamePresent = old.availability !== 'present' && f.availability === 'present';
        if (old.availability === 'missing') summary.returned++;
        update.run({
          id: old.id,
          rel_path: f.relPath,
          rel_dir: f.relDir,
          name: f.name,
          size: f.size,
          created_ms: f.createdMs,
          modified_ms: f.modifiedMs,
          availability: f.availability,
          attributes: f.attributes,
          now,
          reset: changed || becamePresent ? 1 : 0,
          changed: changed ? 1 : 0,
        });
      } else {
        const parsed = parseFilename(f.name);
        insert.run({
          id: newId(),
          folder_id: folder.id,
          rel_path: f.relPath,
          rel_dir: f.relDir,
          name: f.name,
          ext: f.ext,
          format: f.format,
          size: f.size,
          created_ms: f.createdMs,
          modified_ms: f.modifiedMs,
          availability: f.availability,
          attributes: f.attributes,
          parsed: JSON.stringify(parsed),
          compare_key: parsed.compareKey,
          quality_tag: parsed.quality ?? null,
          edition_number: parsed.editionNumber ?? null,
          edition_note: parsed.editionNote ?? null,
          now,
        });
        summary.newFiles++;
      }
    }

    for (const old of existing) {
      if (seen.has(old.rel_path.toLowerCase())) continue;
      if (isKnownAbsent(old.rel_dir, completeDirs, childDirs)) {
        if (old.availability !== 'missing') {
          markMissing.run(old.id);
          summary.missing++;
        } else if (old.stale) markMissing.run(old.id);
      } else {
        markStale.run(old.id);
        summary.stale++;
      }
    }

    for (const d of completeDirs) dirScan.run(folder.id, d, now);
    const complete = summary.status === 'completed';
    db.prepare(
      `UPDATE folders SET last_seen_at = ?, updated_at = ?,
         last_complete_scan_at = CASE WHEN ? THEN ? ELSE last_complete_scan_at END WHERE id = ?`,
    ).run(now, now, complete ? 1 : 0, now, folder.id);
  })();
}

/**
 * Is a file in `relDir` known to be gone? Yes if `relDir` itself was completely listed, or if
 * the nearest completely-listed ancestor no longer contains the next directory on the path.
 */
export function isKnownAbsent(
  relDir: string,
  completeDirs: Set<string>,
  childDirs: Map<string, Set<string>>,
): boolean {
  if (completeDirs.has(relDir)) return true;
  let child = relDir;
  let parent = parentDir(relDir);
  while (parent !== null) {
    if (completeDirs.has(parent)) {
      const name = (parent === '' ? child : child.slice(parent.length + 1)).split('/')[0]!.toLowerCase();
      return !childDirs.get(parent)!.has(name);
    }
    child = parent;
    parent = parentDir(parent);
  }
  return false;
}
