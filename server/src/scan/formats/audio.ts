import { parseFile } from 'music-metadata';
import { thumbnailFromImage } from './thumbnail.ts';
import type { EmbeddedMetadata, MetaResult } from './types.ts';

/**
 * Audiobook files (docs/plans/audiobooks.md): the playing time and the tags, read with
 * music-metadata (pure JavaScript, no install script). Only the file's headers and tags are
 * read for formats with a stated playing time. MP3s without a duration header require a
 * frame scan: matching opening bitrates alone cannot prove the rest is constant bitrate.
 *
 * What the tags mean for a book: the album is the book's title (a chapter file's own title is
 * the chapter's), and the album artist, else the artist, is its author. A narrator isn't
 * guessed: tags have no agreed place for one. Old Audible `.aa` files can't be read; they are
 * listed with an unknown length rather than a made-up one.
 */

/** Formats whose one file is a whole book, so its own title is the book's when no album is set. */
const WHOLE_BOOK = new Set(['m4b', 'aax']);
const UNREADABLE = new Set(['aa']);

export async function readAudio(
  file: string,
  ext: string,
  wantCover: boolean,
): Promise<MetaResult & { jpeg?: Buffer | null }> {
  const empty: MetaResult = {
    metadata: {},
    wordCount: null,
    pageCount: null,
    durationSeconds: null,
  };
  if (UNREADABLE.has(ext)) return { ...empty, jpeg: wantCover ? null : undefined };
  // music-metadata stops at a usable Xing/Info duration; otherwise duration:true counts
  // MPEG frames to the end instead of reporting a file-size estimate as an exact time.
  const m = await parseFile(file, { duration: ext === 'mp3', skipCovers: !wantCover });
  const c = m.common;
  const metadata: EmbeddedMetadata = {};
  const title = clean(c.album) ?? (WHOLE_BOOK.has(ext) ? clean(c.title) : undefined);
  if (title) metadata.title = title;
  const author = clean(c.albumartist) ?? clean(c.artist);
  if (author) metadata.creators = [{ name: author, role: 'author' }];
  if (c.year && c.year > 0) metadata.date = String(c.year);
  if (c.language) metadata.language = c.language;
  const d = m.format.duration;
  let jpeg: Buffer | null | undefined;
  if (wantCover) {
    const pic = c.picture?.[0]?.data;
    jpeg = pic ? await thumbnailFromImage(pic).catch(() => null) : null;
  }
  return {
    metadata,
    wordCount: null,
    pageCount: null,
    durationSeconds: typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null,
    jpeg,
  };
}

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}
