import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { FULL_SNAPSHOTS_KEPT } from '../config.ts';
import type { DB } from '../db/database.ts';
import { schemaVersion } from '../db/database.ts';

/**
 * Full local snapshot (PLAN.md §16): a consistent copy of the database plus the cached covers,
 * in its own folder under data/full-snapshots. Unlike the JSON backup it brings back the
 * covers and the raw source responses too, so nothing needs to be fetched or drawn again.
 *
 * The copy is made with SQLite's backup API (never a file copy of a live database, §6.2), and
 * API keys are then deleted from the copy: keys never leave the live database (§6.3).
 */

export const FULL_SNAPSHOT_DB = 'whatbooksnext.sqlite';

export interface FullSnapshotInfo {
  name: string;
  /** Absolute folder path. */
  path: string;
  createdAt: string;
  covers: number;
  bytes: number;
}

const README = (version: number) => `whatBooksNext full snapshot

This folder is a complete copy of the app's data at the moment it was taken (database version
${version}): your library, progress, ratings, notes, settings, the details found online, and
the cached covers. API keys are NOT included; enter them again in Settings after restoring.
Book files are not included either: they stay where they are.

To go back to this snapshot:
  1. Close the whatBooksNext window (the app must not be running).
  2. In the app's "data" folder, rename "whatbooksnext.sqlite" to "whatbooksnext-old.sqlite"
     and delete "whatbooksnext.sqlite-wal" and "whatbooksnext.sqlite-shm" if they are there.
  3. Copy "whatbooksnext.sqlite" from this folder into the "data" folder.
  4. Replace the "covers" folder in "data" with the "covers" folder from here.
  5. Start the app again.
`;

function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += fs.statSync(path.join(e.parentPath, e.name)).size;
  }
  return { files, bytes };
}

export function fullSnapshotsDir(dataDir: string): string {
  return path.join(dataDir, 'full-snapshots');
}

/** One snapshot at a time per data folder: two at once would race over files and pruning. */
const queues = new Map<string, Promise<unknown>>();

export function takeFullSnapshot(db: DB, dataDir: string): Promise<FullSnapshotInfo> {
  const root = fullSnapshotsDir(dataDir);
  const previous = queues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => snapshotNow(db, dataDir, root));
  queues.set(root, next);
  // Drop the entry once settled, unless another snapshot has queued behind this one.
  void next
    .catch(() => {})
    .then(() => {
      if (queues.get(root) === next) queues.delete(root);
    });
  return next;
}

/**
 * A new folder name nobody else has: created exclusively (no `recursive`), so even another
 * process taking a snapshot in the same millisecond gets "-2", "-3"… instead of sharing it.
 */
function claimName(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `full-${stamp}` : `full-${stamp}-${n}`;
    if (fs.existsSync(path.join(root, name))) continue;
    try {
      fs.mkdirSync(path.join(root, `${name}.partial`));
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not find a free name for the snapshot folder.');
}

async function snapshotNow(db: DB, dataDir: string, root: string): Promise<FullSnapshotInfo> {
  const name = claimName(root);
  const dir = path.join(root, name);
  const partial = `${dir}.partial`;
  try {
    const file = path.join(partial, FULL_SNAPSHOT_DB);
    await db.backup(file);
    const copy = new Database(file);
    try {
      copy.prepare('DELETE FROM secrets').run();
      // Rewrites the file, so the deleted keys aren't left behind in free pages.
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    const covers = path.join(dataDir, 'covers');
    if (fs.existsSync(covers)) fs.cpSync(covers, path.join(partial, 'covers'), { recursive: true });
    else fs.mkdirSync(path.join(partial, 'covers'));
    fs.writeFileSync(path.join(partial, 'README.txt'), README(schemaVersion(db)));
    // Only a finished snapshot gets its real name, so a half-written one is never listed.
    fs.renameSync(partial, dir);
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  pruneFullSnapshots(root, FULL_SNAPSHOTS_KEPT);
  return infoOf(root, name);
}

function infoOf(root: string, name: string): FullSnapshotInfo {
  const dir = path.join(root, name);
  const all = dirSize(dir);
  return {
    name,
    path: dir,
    createdAt: fs.statSync(path.join(dir, FULL_SNAPSHOT_DB)).mtime.toISOString(),
    covers: dirSize(path.join(dir, 'covers')).files,
    bytes: all.bytes,
  };
}

const isSnapshot = (root: string, n: string) =>
  /^full-\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?$/.test(n) &&
  fs.existsSync(path.join(root, n, FULL_SNAPSHOT_DB));

function pruneFullSnapshots(root: string, keep: number): void {
  const mine = fs
    .readdirSync(root)
    .filter((n) => isSnapshot(root, n))
    .sort(); // ISO timestamps sort chronologically
  for (const old of mine.slice(0, Math.max(0, mine.length - keep)))
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
}

export function listFullSnapshots(dataDir: string): FullSnapshotInfo[] {
  const root = fullSnapshotsDir(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => isSnapshot(root, n))
    .sort()
    .reverse()
    .map((n) => infoOf(root, n));
}
