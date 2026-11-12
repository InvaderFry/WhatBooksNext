import { PAGE_PREVIEW_MAX_SIDE } from '../../config.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { COMIC_ARCHIVE_IMAGE_SHARE, MAX_RAR_BYTES } from '../../config.ts';
import { isImageName } from './images.ts';
import { naturalCompare } from './text.ts';
import { thumbnailFromImage } from './thumbnail.ts';
import type { EmbeddedMetadata, MetaResult } from './types.ts';
import { parseXml, textOf } from './xml.ts';
import { checkArchiveLimits, LimitError, ZipReader, type ArchiveEntry } from './zip.ts';

/**
 * CBZ / CBR (PLAN.md §10): ComicInfo.xml when present, page count from the images in order,
 * and the cover. `.zip` and `.rar` must turn out to be mostly page images (§9.1).
 */

interface Archive {
  entries: ArchiveEntry[];
  /** The full SHA-256, when the whole file was read anyway (RAR): no second pass to hash it. */
  fullHash?: string;
  read(name: string): Promise<Uint8Array>;
  close(): void;
}

async function openZip(file: string): Promise<Archive> {
  const z = await ZipReader.open(file, { checkLimits: false });
  return { entries: z.entries, read: (n) => z.read(n), close: () => z.close() };
}

/**
 * RAR through node-unrar-js (WebAssembly: no native build on Windows). It needs the whole
 * archive in memory, hence MAX_RAR_BYTES. It is only ever loaded inside a worker thread: its
 * Emscripten runtime installs process-wide error handlers we don't want in the server.
 */
async function openRar(file: string): Promise<Archive> {
  const size = fs.statSync(file).size;
  if (size > MAX_RAR_BYTES)
    throw new LimitError(
      'too_large',
      'The RAR archive is too large to read in memory (over 1 GB).',
    );
  const { createExtractorFromData } = await import('node-unrar-js');
  const data = fs.readFileSync(file);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const extractor = await createExtractorFromData({ data: ab });
  const list = extractor.getFileList();
  if (list.arcHeader.flags.headerEncrypted)
    throw new LimitError('encrypted', 'The archive is password-protected.');
  const entries: ArchiveEntry[] = [];
  for (const h of list.fileHeaders) {
    if (h.flags.directory) continue;
    if (h.flags.encrypted) throw new LimitError('encrypted', 'The archive is password-protected.');
    entries.push({ name: h.name, size: h.unpSize, compressedSize: h.packSize });
  }
  return {
    entries,
    fullHash: createHash('sha256').update(data).digest('hex'),
    async read(name) {
      const out = extractor.extract({ files: [name] });
      // unrar releases the archive only when this iterator is exhausted. Returning from
      // inside it prevents the next page (or metadata followed by cover) from being read.
      let bytes: Uint8Array | undefined;
      for (const f of out.files) if (f.extraction) bytes = f.extraction;
      if (bytes) return bytes;
      throw new Error(`No entry "${name}".`);
    },
    close() {},
  };
}

export type ArchiveKind = 'zip' | 'rar' | '7z' | 'unknown';

/**
 * What an archive really is, from its first bytes. Extensions lie: many ".cbr" comics are ZIP
 * files renamed (and some ".cbz" are RAR), which comic readers open by looking inside, as we
 * do. Found on the owner's drive: dozens of ".cbr" files that are ZIPs.
 */
export function sniffArchive(file: string): ArchiveKind {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2]!)) return 'zip';
  if (head.toString('latin1', 0, 6) === 'Rar!\x1a\x07') return 'rar';
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return '7z';
  return 'unknown';
}

/**
 * Opens a comic archive by what it is, not what it's called. Null for a 7-Zip archive: like a
 * ".cb7", it's listed by name only (§9.1), not reported as damaged.
 */
export async function openComicArchive(file: string, format: string): Promise<Archive | null> {
  const kind = sniffArchive(file);
  if (kind === '7z') return null;
  if (kind === 'rar') return openRar(file);
  if (kind === 'zip') return openZip(file);
  // Unrecognised start: try what the extension says, so the error names the expected format.
  return format === 'cbr' ? openRar(file) : openZip(file);
}

/** Files that ride along in comic archives and say nothing about whether it's a comic. */
const SIDECAR =
  /(^|[\\/])(__macosx[\\/].*|\..*|thumbs\.db|desktop\.ini|.*\.(xml|txt|nfo|sfv|url|db|md5|ini|html?))$/i;

export function pageImages(entries: ArchiveEntry[]): string[] {
  return entries
    .map((e) => e.name)
    .filter((n) => isImageName(n) && !/(^|[\\/])(__macosx|\.)/i.test(n))
    .sort(naturalCompare);
}

/** Is this archive mostly page images? Returns why not, or null when it's a comic. */
export function notAComicReason(entries: ArchiveEntry[]): string | null {
  const relevant = entries.filter((e) => !SIDECAR.test(e.name));
  const images = pageImages(entries).length;
  // Say what it does hold, so the owner can tell an audiobook from a comic packed oddly.
  const holds = describeContents(relevant);
  if (images < 2)
    return `It holds ${images === 0 ? 'no' : 'only one'} image${holds ? `; it has ${holds}` : ''}.`;
  if (images / relevant.length < COMIC_ARCHIVE_IMAGE_SHARE)
    return `Only ${images} of its ${relevant.length} files are images; it has ${holds}.`;
  return null;
}

/** "12 .mp3, 1 .rar" — the most common file types in an archive. */
export function describeContents(entries: ArchiveEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (isImageName(e.name)) continue;
    const base = e.name.split(/[\\/]/).pop() ?? e.name;
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : 'files without a type';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 4).map(([ext, n]) => `${n} ${ext}`);
  if (top.length > 4) shown.push('more');
  return shown.join(', ');
}

export function comicInfoMetadata(xml: string): EmbeddedMetadata {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => c.local.toLowerCase() === 'comicinfo') ?? doc;
  const get = (k: string) => {
    const el = root.children.find((c) => c.local.toLowerCase() === k.toLowerCase());
    const t = el ? textOf(el).replace(/\s+/g, ' ').trim() : '';
    return t || undefined;
  };
  const manga = get('Manga')?.toLowerCase();
  const pageCount = Number(get('PageCount'));
  const comic: NonNullable<EmbeddedMetadata['comic']> = {
    series: get('Series'),
    number: get('Number'),
    volume: get('Volume'),
    title: get('Title'),
    year: get('Year'),
    writer: get('Writer'),
    penciller: get('Penciller'),
    publisher: get('Publisher'),
    genre: get('Genre'),
    manga:
      manga === 'yesandrighttoleft'
        ? 'yes_rtl'
        : manga === 'yes'
          ? 'yes'
          : manga === 'no'
            ? 'no'
            : undefined,
    pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : undefined,
  };
  for (const k of Object.keys(comic) as (keyof typeof comic)[])
    if (comic[k] === undefined) delete comic[k];
  const m: EmbeddedMetadata = { comic };
  if (comic.title) m.title = comic.title;
  if (comic.series) m.series = comic.series;
  if (comic.number) m.seriesIndex = comic.number;
  const lang = get('LanguageISO');
  if (lang) m.language = lang.toLowerCase();
  if (comic.publisher) m.publisher = comic.publisher;
  const creators = [
    ...(comic.writer ?? '').split(',').map((n) => ({ name: n.trim(), role: 'writer' })),
    ...(comic.penciller ?? '').split(',').map((n) => ({ name: n.trim(), role: 'penciller' })),
  ].filter((c) => c.name);
  if (creators.length) m.creators = creators;
  const summary = get('Summary');
  if (summary) m.description = summary.slice(0, 5000);
  return m;
}

/**
 * Details, and the cover when asked, from one open of the archive. A RAR is read whole anyway,
 * so its fingerprint comes from that same read.
 */
export async function readComic(
  file: string,
  format: string,
  isZipOrRar: boolean,
  wantCover = false,
): Promise<MetaResult & { jpeg?: Buffer | null; fullHash?: string }> {
  const a = await openComicArchive(file, format);
  if (!a) return { metadata: {}, wordCount: null, pageCount: null };
  try {
    // "Is it a comic?" comes before the size limits: a 3 GB audiobook zip is not a comic,
    // which is the more useful thing to say about it.
    const reason = notAComicReason(a.entries);
    if (reason && isZipOrRar)
      return {
        metadata: {},
        wordCount: null,
        pageCount: null,
        notComic: reason,
        fullHash: a.fullHash,
      };
    checkArchiveLimits(a.entries);
    const info = a.entries.find((e) => /(^|[\\/])comicinfo\.xml$/i.test(e.name));
    let metadata: EmbeddedMetadata = {};
    if (info) metadata = comicInfoMetadata(Buffer.from(await a.read(info.name)).toString('utf8'));
    const pages = pageImages(a.entries);
    let jpeg: Buffer | null | undefined;
    if (wantCover) jpeg = pages[0] ? await coverFrom(a, pages[0]) : null;
    return {
      metadata,
      wordCount: null,
      pageCount: pages.length > 0 ? pages.length : null,
      jpeg,
      fullHash: a.fullHash,
    };
  } finally {
    a.close();
  }
}

/** A cover that can't be drawn is no cover, not a damaged comic; a limit still counts. */
async function coverFrom(a: Archive, name: string): Promise<Buffer | null> {
  try {
    return await thumbnailFromImage(await a.read(name));
  } catch (err) {
    if (err instanceof LimitError) throw err;
    return null;
  }
}

export async function comicThumbnail(file: string, format: string): Promise<Buffer | null> {
  const a = await openComicArchive(file, format);
  if (!a) return null;
  try {
    checkArchiveLimits(a.entries);
    const first = pageImages(a.entries)[0];
    return first ? await thumbnailFromImage(await a.read(first)) : null;
  } finally {
    a.close();
  }
}

/** The first two images in reading order, with the same archive and pixel limits as scanning. */
export async function comicPagePreviews(file: string, format: string): Promise<Buffer[]> {
  const a = await openComicArchive(file, format);
  if (!a) return [];
  try {
    checkArchiveLimits(a.entries);
    const pages: Buffer[] = [];
    for (const name of pageImages(a.entries).slice(0, 2))
      pages.push(await thumbnailFromImage(await a.read(name), PAGE_PREVIEW_MAX_SIDE));
    return pages;
  } finally {
    a.close();
  }
}
