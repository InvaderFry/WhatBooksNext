import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry } from './types.ts';

/**
 * Lists a directory with Node: readdir, then lstat for sizes and dates. lstat reads metadata
 * and never follows a link. `attributes` is what to report for every entry: 0x20 (ordinary
 * file) where the platform has no placeholders, or null where they are simply unknown.
 */
export async function listWithNode(absDir: string, attributes: number | null): Promise<DirEntry[]> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const d of dirents) {
    const isLink = d.isSymbolicLink();
    let size = 0;
    let modifiedMs: number | null = null;
    let createdMs: number | null = null;
    try {
      const st = await fs.promises.lstat(path.join(absDir, d.name));
      size = st.isFile() ? st.size : 0;
      modifiedMs = Math.round(st.mtimeMs);
      createdMs = Math.round(st.birthtimeMs) || null;
    } catch {
      // vanished between readdir and lstat; report what we have
    }
    out.push({ name: d.name, isDirectory: d.isDirectory(), isLink, size, modifiedMs, createdMs, attributes });
  }
  return out;
}
