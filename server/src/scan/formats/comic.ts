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
  read(name: string): Promise<Uint8Array>;
  close(): void;
}

async function openZip(file: string): Promise<Archive> {
  const z = await ZipReader.open(file);
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
  checkArchiveLimits(entries);
  return {
    entries,
    async read(name) {
      const out = extractor.extract({ files: [name] });
      for (const f of out.files) if (f.extraction) return f.extraction;
      throw new Error(`No entry "${name}".`);
    },
    close() {},
  };
}

export function openComicArchive(file: string, format: string): Promise<Archive> {
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
  if (images < 2) return `It holds ${images === 0 ? 'no' : 'only one'} image.`;
  if (images / relevant.length < COMIC_ARCHIVE_IMAGE_SHARE)
    return `Only ${images} of its ${relevant.length} files are images.`;
  return null;
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

export async function readComic(
  file: string,
  format: string,
  isZipOrRar: boolean,
): Promise<MetaResult> {
  const a = await openComicArchive(file, format);
  try {
    const reason = notAComicReason(a.entries);
    if (reason && isZipOrRar)
      return { metadata: {}, wordCount: null, pageCount: null, notComic: reason };
    const info = a.entries.find((e) => /(^|[\\/])comicinfo\.xml$/i.test(e.name));
    let metadata: EmbeddedMetadata = {};
    if (info) metadata = comicInfoMetadata(Buffer.from(await a.read(info.name)).toString('utf8'));
    const pages = pageImages(a.entries).length;
    return { metadata, wordCount: null, pageCount: pages > 0 ? pages : null };
  } finally {
    a.close();
  }
}

export async function comicThumbnail(file: string, format: string): Promise<Buffer | null> {
  const a = await openComicArchive(file, format);
  try {
    const first = pageImages(a.entries)[0];
    return first ? await thumbnailFromImage(await a.read(first)) : null;
  } finally {
    a.close();
  }
}
