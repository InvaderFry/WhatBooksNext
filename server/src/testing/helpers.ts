import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, openDatabase, type DB } from '../db/database.ts';
import { FakePlatform } from '../platform/fake.ts';

export async function memoryDb(): Promise<DB> {
  const db = openDatabase(':memory:');
  await migrate(db, { snapshotDir: null });
  return db;
}

export function tempDir(prefix = 'wbn-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes files (relative path -> size in bytes, or exact content) under `root`. */
export function writeFiles(root: string, files: Record<string, number | string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'number' ? Buffer.alloc(content, 1) : content);
  }
}

/** A fake platform with one "drive" per root, as the M0 probe found (a USB drive, external). */
export function fakePlatformWithDrives(drives: Record<string, string>): FakePlatform {
  const p = new FakePlatform();
  for (const [label, root] of Object.entries(drives)) {
    p.addVolume({
      volumeId: `vol-${label}`,
      label,
      storageKind: 'external',
      root: path.resolve(root),
    });
  }
  return p;
}
