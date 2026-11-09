import { comicThumbnail, readComic } from './comic.ts';
import { epubThumbnail, readEpub } from './epub.ts';
import { fullHash, partialHash } from './hash.ts';
import { pdfThumbnail, readPdf } from './pdf.ts';
import type { MetaResult } from './types.ts';

/**
 * The content readers, by task. ONLY the worker pool calls these, and the pool is only ever
 * handed work by the content-read guard (`scan/guard.ts`), which re-checks the file's attributes
 * immediately before each task (§9.5). Nothing else in the app imports this module.
 *
 * One `read` task per file gives its details and its cover from a single open, so a file is
 * read off the drive once, not once per stage (the owner's first scan was disk-bound). When a
 * reader has the whole file in memory anyway (RAR), the fingerprint comes from that read too.
 */

export type Task =
  | { kind: 'read'; file: string; format: string; ext: string; wantCover: boolean }
  | { kind: 'thumb'; file: string; format: string }
  | { kind: 'full_hash'; file: string };

export type TaskResult =
  | {
      kind: 'read';
      meta: MetaResult;
      partialHash: string;
      /** Undefined: no cover was asked for. Null: the file has none that can be drawn. */
      jpeg?: Uint8Array | null;
      fullHash?: string;
    }
  | { kind: 'thumb'; jpeg: Uint8Array | null }
  | { kind: 'full_hash'; hash: string; partialHash: string };

export async function runTask(t: Task): Promise<TaskResult> {
  switch (t.kind) {
    case 'read': {
      const ph = partialHash(t.file);
      if (t.format === 'epub') {
        const meta = await readEpub(t.file);
        // ZIP-based: only the cover's own entry is read, so a second open costs little.
        const jpeg = t.wantCover ? await epubThumbnail(t.file).catch(coverError) : undefined;
        return { kind: 'read', meta, partialHash: ph, jpeg };
      }
      if (t.format === 'pdf') {
        const { jpeg, ...meta } = await readPdf(t.file, t.wantCover);
        return { kind: 'read', meta, partialHash: ph, jpeg };
      }
      const {
        jpeg,
        fullHash: fh,
        ...meta
      } = await readComic(t.file, t.format, t.ext === 'zip' || t.ext === 'rar', t.wantCover);
      return { kind: 'read', meta, partialHash: ph, jpeg, fullHash: fh };
    }
    case 'thumb': {
      let jpeg: Buffer | null;
      if (t.format === 'epub') jpeg = await epubThumbnail(t.file);
      else if (t.format === 'pdf') jpeg = await pdfThumbnail(t.file);
      else jpeg = await comicThumbnail(t.file, t.format);
      return { kind: 'thumb', jpeg };
    }
    case 'full_hash':
      return { kind: 'full_hash', hash: await fullHash(t.file), partialHash: partialHash(t.file) };
  }
}

/** A cover that can't be drawn is no cover; a safety limit is still reported. */
function coverError(err: Error & { limit?: string }): null {
  if (err.limit) throw err;
  return null;
}
