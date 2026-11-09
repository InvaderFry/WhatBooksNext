import { comicThumbnail, readComic } from './comic.ts';
import { epubThumbnail, readEpub } from './epub.ts';
import { fullHash, partialHash } from './hash.ts';
import { pdfThumbnail, readPdf } from './pdf.ts';
import type { MetaResult } from './types.ts';

/**
 * The content readers, by task. ONLY the worker pool calls these, and the pool is only ever
 * handed work by the content-read guard (`scan/guard.ts`), which re-checks the file's attributes
 * immediately before each read (§9.5). Nothing else in the app imports this module.
 */

export type Task =
  | { kind: 'meta'; file: string; format: string; ext: string }
  | { kind: 'thumb'; file: string; format: string }
  | { kind: 'full_hash'; file: string };

export type TaskResult =
  | { kind: 'meta'; meta: MetaResult; partialHash: string }
  | { kind: 'thumb'; jpeg: Uint8Array | null }
  | { kind: 'full_hash'; hash: string; partialHash: string };

export async function runTask(t: Task): Promise<TaskResult> {
  switch (t.kind) {
    case 'meta': {
      const ph = partialHash(t.file);
      let meta: MetaResult;
      if (t.format === 'epub') meta = await readEpub(t.file);
      else if (t.format === 'pdf') meta = await readPdf(t.file);
      else meta = await readComic(t.file, t.format, t.ext === 'zip' || t.ext === 'rar');
      return { kind: 'meta', meta, partialHash: ph };
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
