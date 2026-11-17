/**
 * Which audio files make one audiobook (docs/plans/audiobooks.md). Pure: names in, books out.
 *
 * Audiobooks come two ways: one big file per book, or a folder of chapter files, sometimes
 * split over "CD 1", "CD 2" subfolders. The owner wasn't sure which they have, so both are
 * read from the names alone, cautiously:
 *
 *  - Files whose names differ by explicit part markers ("Title Part 1", "Title Part 2")
 *    are parts of one book, named by what they share. A bare trailing number may be a book
 *    in a series, so it stays in the title for every audio format.
 *  - Files that start with a track number ("01 - Dawn", "1-02 Dusk") are the chapters of the
 *    book their folder is named for. Not for .m4b/.aa/.aax, which hold a whole book each: a
 *    numbered one is a book in a series.
 *  - Explicit track names ("Track 03", "Chapter 12") and zero-padded short track numbers
 *    ("01", "02") belong to the folder's book. Numeric titles otherwise stay intact.
 *  - Any other file is a book of its own, named by the file.
 *
 * A "CD 1" style folder takes its book from the folder above it, so discs join up.
 */

/** Audio files that can be an audiobook. Only looked at inside the owner's audiobook folders. */
export const AUDIO_EXTENSIONS = [
  'mp3',
  'm4b',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'wma',
  'aa',
  'aax',
] as const;

const AUDIO = new Set<string>(AUDIO_EXTENSIONS);

/** Formats that hold a whole book in one file. */
const WHOLE_BOOK = new Set(['m4b', 'aa', 'aax']);

export function isAudioExt(ext: string): boolean {
  return AUDIO.has(ext.toLowerCase());
}

const PART_WORDS = 'chapter|chap|ch|part|pt|track|disc|disk|cd|side|section|episode|ep';
/** "Part 2", "CD 1 of 3": a number that a part word introduces. */
const NAMED_PART = new RegExp(
  `\\b(?:${PART_WORDS})\\.?\\s*\\d{1,4}\\b(?:\\s*(?:of|-)\\s*\\d{1,4}\\b)?`,
  'gi',
);
const DISC_DIR = /^(?:cd|disc|disk|part|pt|side)[\s._-]*\d{1,3}$/i;
/** A short leading track number followed by a named chapter, not a numeric book title. */
const LEADING_NUMBER = /^\s*(?:\(\d{1,3}\)|\d{1,3}(?:[-.]\d{1,3})?)[\s._–—-]+(?=\p{L})/u;
const PADDED_TRACK = /^0\d{1,2}$/;

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const tidy = (s: string) =>
  s
    .replace(/[_]+/g, ' ')
    .replace(/\s*[-–—:,.]+\s*$/g, '')
    .replace(/^\s*[-–—:,.]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The name with explicit part markers taken out. Bare numbers belong to the title:
 * "Lantern 22 Part 2.mp3" → "Lantern 22"; "Lantern Saga 3.mp3" stays unchanged.
 */
export function partStem(name: string): string {
  const t = baseName(name).replace(/_/g, ' ').replace(NAMED_PART, ' ');
  return tidy(t.replace(/[([{]\s*[)\]}]/g, ' ').replace(/\s+[-–—]\s+(?=[-–—]|$)/g, ' '));
}

const keyOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface AudioBookOf {
  /** The book's name, for the filename parser (no extension). */
  bookName: string;
  /** The directory the book lives in, below the library folder ('' is the folder itself). */
  bookDir: string;
}

/**
 * The book each audio file of one directory belongs to.
 *
 * @param relDir the directory, '/'-separated, below the library folder ('' is the folder)
 * @param names the audio file names in it
 * @param rootName the library folder's own name, for chapter files lying directly in it
 */
export function audioBooksInDirectory(
  relDir: string,
  names: string[],
  rootName: string,
): Map<string, AudioBookOf> {
  const out = new Map<string, AudioBookOf>();
  const segments = relDir ? relDir.split('/') : [];
  // "Book/CD 1" → the book is "Book".
  let dirSegments = segments;
  while (dirSegments.length > 0 && DISC_DIR.test(dirSegments.at(-1)!))
    dirSegments = dirSegments.slice(0, -1);
  const onDisc = dirSegments.length !== segments.length;
  const folderBook: AudioBookOf = {
    bookName: dirSegments.at(-1) ?? rootName,
    bookDir: dirSegments.join('/'),
  };

  const stems = new Map<string, string[]>();
  for (const n of names) {
    const k = keyOf(partStem(n));
    if (!stems.has(k)) stems.set(k, []);
    stems.get(k)!.push(n);
  }

  for (const n of names) {
    const stem = partStem(n);
    const k = keyOf(stem);
    const sharing = stems.get(k)!.length;
    const paddedTrack =
      !WHOLE_BOOK.has(extOf(n)) && PADDED_TRACK.test(baseName(n)) && names.length > 1;
    if (k === '' || onDisc || paddedTrack) {
      // An explicit or zero-padded track, or a file on a disc: the folder's book.
      out.set(n, folderBook);
    } else if (sharing > 1) {
      // "Title Part 1" and "Title Part 2": one book, named by what they share.
      out.set(n, { bookName: stem, bookDir: relDir });
    } else if (LEADING_NUMBER.test(baseName(n)) && !WHOLE_BOOK.has(extOf(n)) && names.length > 1) {
      // "01 - Dawn", "02 - Dusk": chapters of the folder's book.
      out.set(n, folderBook);
    } else {
      out.set(n, { bookName: baseName(n), bookDir: relDir });
    }
  }
  return out;
}

/** Is `relDir` inside one of the folder's audiobook directories ('' is the whole folder)? */
export function inAudiobookDirs(relDir: string, dirs: string[]): boolean {
  const d = relDir.toLowerCase();
  return dirs.some((a) => {
    const k = a.toLowerCase();
    return k === '' || d === k || d.startsWith(`${k}/`);
  });
}

/** Parts in listening order: "2" before "10", discs in order. */
export function comparePartPaths(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/** "9 h 12 min", "45 min": a playing time is exact, so no "~" and no range. */
export function formatListen(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}
