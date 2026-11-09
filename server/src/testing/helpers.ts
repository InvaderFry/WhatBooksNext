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

/**
 * Filler content of `size` bytes, the same for the same file name (so two copies of a file
 * really are copies, down to their hashes) and different for different names.
 */
export function fillerFor(name: string, size: number): Buffer {
  const seed = Buffer.from(`${name.toLowerCase()}|`);
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += seed.length) seed.copy(b, i);
  return b;
}

/** Writes files (relative path -> size in bytes, or exact content) under `root`. */
export function writeFiles(root: string, files: Record<string, number | string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      typeof content === 'number' ? fillerFor(path.basename(abs), content) : content,
    );
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
