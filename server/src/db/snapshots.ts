import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './database.ts';

/**
 * Consistent snapshot through SQLite's Online Backup API (better-sqlite3 `db.backup()`),
 * never a file copy: copying a live database file can produce a corrupt backup (§6.2).
 * Snapshots of one `prefix` are pruned to the newest `keep`, so pre-migration and pre-restore
 * snapshots never push each other out (§16).
 */
export async function takeSnapshot(
  db: DB,
  dir: string,
  prefix: string,
  keep: number,
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${prefix}-${stamp}.sqlite`);
  await db.backup(file);
  pruneSnapshots(dir, prefix, keep);
  return file;
}

function kindOf(name: string): string {
  // "pre-migration-v3-2026-...sqlite" -> "pre-migration"
  return name.replace(/-v\d+(-.*)?$/, '').replace(/-\d{4}-\d{2}-\d{2}T.*$/, '');
}

export function pruneSnapshots(dir: string, prefix: string, keep: number): void {
  const kind = kindOf(prefix);
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite') && kindOf(f) === kind)
    .sort(); // ISO timestamps sort chronologically
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
}

export interface SnapshotInfo {
  file: string;
  kind: string;
  createdAt: string;
}

export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({
      file: path.join(dir, f),
      kind: kindOf(f),
      createdAt: fs.statSync(path.join(dir, f)).mtime.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
