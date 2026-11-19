/**
 * Which audio files make one audiobook (docs/plans/audiobooks.md). Pure: names in, books out.
 *
 * Audiobooks come two ways: one big file per book, or a folder of chapter files, sometimes
 * split over "CD 1", "CD 2" subfolders. The owner wasn't sure which they have, so both are
 * read from the names alone:
 *
 *  - Folder first (owner decision 2026-11-19, after seeing the real layouts): when a folder
 *    holds several numbered audio files that start with a number ("01 - Dawn", "0.00.1 Credits",
 *    "01(4) Title") or share their opening letters ("Chapter 01 - …", "Title - 1 of 4",
 *    "CODE521P01"), they are the chapters of the book the folder is named for, together with any
 *    unnumbered file beside them ("Credits"). Not for .m4b/.aa/.aax, which hold a whole book each.
 *  - Otherwise, files whose names differ by explicit part markers ("Title Part 1", "Title Part 2")
 *    are parts of one book, named by what they share.
 *  - Explicit track names ("Track 03") and zero-padded short track numbers ("01") belong to the
 *    folder's book. Any other file is a book of its own, named by the file.
 *
 * A "CD 1" or "Title Disc 3" folder takes its book from the folder above it, so discs join up;
 * so does a generic folder such as "Audiobook" or "MP3". Audible download names
 * ("TitleUnabridgedPart1_mp332_account.aa") lose the codec and account and get their spaces back.
 */
import { AUDIO_CHAPTER_SHARED_LETTERS } from '../config.ts';

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
/** "Title Disc 3", "Title CD 10": a disc folder that repeats the book's title. */
const TITLED_DISC_DIR = /^(.*\p{L}.*?)[\s._-]+(?:cd|disc|disk)[\s._-]*\d{1,3}$/iu;
/** Folder names that say nothing about the book: the book is the folder above. */
const GENERIC_DIR = /^(?:audio\s*books?|audio|mp3s?|files|tracks|unabridged|cds?|discs?)$/i;
/**
 * Audible's download names end with a codec and often the account: "…_mp332_name.aa",
 * "…_ep6.aax", "…_lc_128_44_stereo".
 */
const AUDIBLE_SUFFIX =
  /_(?:mp332|mp364|mp3|acelp16|acelp85|ep6|aax|lc_\d+_\d+(?:_[a-z]+)?)(?:_[^_]*)?$/i;
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
  const t = cleanAudibleName(baseName(name)).replace(/_/g, ' ').replace(NAMED_PART, ' ');
  return tidy(t.replace(/[([{]\s*[)\]}]/g, ' ').replace(/\s+[-–—]\s+(?=[-–—]|$)/g, ' '));
}

/**
 * "WhattheDogSawUnabridgedPart1_mp332_account" → "Whatthe Dog Saw Part1": Audible's download
 * names without codec, account or "Unabridged". Other names come back unchanged.
 */
export function cleanAudibleName(base: string): string {
  if (!AUDIBLE_SUFFIX.test(base)) return base;
  return base
    .replace(AUDIBLE_SUFFIX, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, (m, l: string, d: string) => (/[a-z]/i.test(l) ? `${l}${d}` : m))
    .replace(/\b(?:Un)?abridged\b/gi, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const { folderBook, onDisc } = bookOfDirectory(relDir, rootName);

  const chapterLike = names.filter((n) => !WHOLE_BOOK.has(extOf(n)));
  // Lying in the library folder itself, only files that start with a number are chapters: the
  // library folder's name rarely names one book.
  const chapters =
    onDisc ||
    (relDir === ''
      ? chapterLike.length > 1 && chapterLike.every((n) => /^\s*[([]?\d/.test(baseName(n)))
      : isChapterFolder(chapterLike));

  const stems = new Map<string, string[]>();
  for (const n of names) {
    const k = keyOf(partStem(n));
    if (!stems.has(k)) stems.set(k, []);
    stems.get(k)!.push(n);
  }

  for (const n of names) {
    const whole = WHOLE_BOOK.has(extOf(n));
    const stem = partStem(n);
    const k = keyOf(stem);
    const sharing = stems.get(k)!.length;
    const paddedTrack = !whole && PADDED_TRACK.test(baseName(n)) && names.length > 1;
    if (sharing > 1 && k !== '' && !onDisc && (whole || sharing === chapterLike.length)) {
      // "Title Part 1" and "Title Part 2" (and nothing else beside them): one book, named by
      // what they share, which also holds where the folder is a general one.
      out.set(n, { bookName: stem, bookDir: folderBook.bookDir });
    } else if ((chapters && !whole) || k === '' || paddedTrack) {
      // Chapters, an explicit or zero-padded track, or a file on a disc: the folder's book.
      out.set(n, folderBook);
    } else if (sharing > 1) {
      // "Title Part 1" and "Title Part 2": one book, named by what they share.
      out.set(n, { bookName: stem, bookDir: folderBook.bookDir });
    } else {
      out.set(n, { bookName: cleanAudibleName(baseName(n)), bookDir: relDir });
    }
  }
  return out;
}

/**
 * The book a directory of chapters stands for. Disc folders ("CD 1", "Title Disc 3", and a
 * title folder inside one: "Title Disc 1/Title") and generic folders ("Audiobook") give way to
 * the folder above, so a book's discs all name the same book.
 */
function bookOfDirectory(
  relDir: string,
  rootName: string,
): { folderBook: AudioBookOf; onDisc: boolean } {
  let segs = relDir ? relDir.split('/') : [];
  let onDisc = false;
  let discTitle: string | null = null;
  for (;;) {
    const last = segs.at(-1);
    if (last === undefined) break;
    const titled = TITLED_DISC_DIR.exec(last);
    const before = segs.at(-2);
    const beforeTitled = before === undefined ? null : TITLED_DISC_DIR.exec(before);
    if (DISC_DIR.test(last) || titled) {
      onDisc = true;
      discTitle = titled?.[1]?.trim() ?? discTitle;
      segs = segs.slice(0, -1);
    } else if (
      before !== undefined &&
      (DISC_DIR.test(before) || beforeTitled) &&
      (GENERIC_DIR.test(last) ||
        keyOf(last) === keyOf(beforeTitled?.[1] ?? '') ||
        keyOf(last) === keyOf(segs.at(-3) ?? ''))
    ) {
      // "Ember Disc 1/Ember": the title folder inside a disc folder.
      segs = segs.slice(0, -1);
    } else if (GENERIC_DIR.test(last) && segs.length > 1) {
      segs = segs.slice(0, -1);
    } else break;
  }
  return {
    folderBook: {
      bookName: tidyBookName(discTitle ?? segs.at(-1) ?? rootName),
      bookDir: segs.join('/'),
    },
    onDisc,
  };
}

/**
 * A folder's name as a book's name: without a leading order number ("02 - Author - Title", from
 * a numbered list of books) or the words "unabridged" and "audiobook", which no title needs.
 * "Book 01 - Title" keeps its number: the filename parser reads it as the series number.
 */
export function tidyBookName(name: string): string {
  const t = name
    .replace(/_+/g, ' ')
    .replace(/^\s*\d{1,3}\s*[-–—.]\s+(?=\S)/u, '')
    .replace(/[([]?\b(?:un)?abridged(?:\s+audio\s*book)?\b[)\]]?/giu, ' ')
    .replace(/\baudio\s*books?\b/giu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—:,]+$/u, '')
    .trim();
  return t || name;
}

const lettersOf = (n: string) =>
  baseName(n)
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, '');

/**
 * Are these the chapters of one book? Two or more numbered files that start with a number or
 * share their opening letters; unnumbered files beside them come along ("Credits").
 */
function isChapterFolder(names: string[]): boolean {
  const numbered = names.filter((n) => /\d/.test(cleanAudibleName(baseName(n))));
  if (numbered.length < 2) return false;
  if (numbered.every((n) => /^\s*[([]?[a-z]?\d/i.test(baseName(n)))) return true;
  const letters = numbered.map(lettersOf);
  if (letters.every((l) => l === letters[0]) && letters[0] !== '') return true;
  let shared = letters[0]!.length;
  for (const l of letters) {
    let i = 0;
    while (i < shared && i < l.length && l[i] === letters[0]![i]) i++;
    shared = i;
  }
  return shared >= AUDIO_CHAPTER_SHARED_LETTERS;
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
