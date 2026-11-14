import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  PAGE_PREVIEW_MAX_SIDE,
  COMIC_ASPECT_MAX,
  COMIC_ASPECT_MIN,
  MAX_IMAGE_PIXELS,
  PDF_RANGE_CHUNK,
  PDF_FULL_PAGE_IMAGE,
  PDF_ISBN_PAGES,
  PDF_TEXT_PAGE_CHARS,
  PDF_TYPE_MAJORITY,
  PDF_TYPE_SAMPLE_PAGES,
  THUMBNAIL_MAX_SIDE,
  THUMBNAIL_QUALITY,
} from '../../config.ts';
import { countWords, findIsbns } from './text.ts';
import type { EmbeddedMetadata, MetaResult, PdfTypeResult } from './types.ts';
import { LimitError } from './zip.ts';

/**
 * PDF (PLAN.md §10) with pdf.js (pdfjs-dist, Mozilla's maintained reader; its Node build renders
 * through @napi-rs/canvas). Info and XMP metadata, page count, a text-layer word count, ISBN
 * candidates from the first pages, the PDF type from sampled pages, and a page-1 thumbnail.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const pkgDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const dataDir = (name: string) => path.join(pkgDir, name).split(path.sep).join('/') + '/';

/** Bytes the PDF reader fetched from disk in this worker (for the benchmark and tests). */
export const pdfReadStats = { bytes: 0 };

/**
 * pdf.js fetches byte ranges as it needs them, read straight from the file. It never loads
 * the whole PDF: a 300 MB comic gives up its details without being read off the drive in
 * full, and files over 2 GB (Node's limit for one read) work (owner's first scan: 6 omnibus
 * PDFs of 2–4 GB failed the old whole-file read).
 */
async function openPdf(file: string) {
  const pdfjs = await loadPdfJs();
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  if (size === 0) {
    fs.closeSync(fd);
    throw new Error('The file is empty (0 bytes).');
  }
  const read = (begin: number, end: number) => {
    const b = Buffer.alloc(Math.max(0, Math.min(end, size) - begin));
    let done = 0;
    while (done < b.length) {
      const n = fs.readSync(fd, b, done, b.length - done, begin + done);
      if (n === 0) break;
      done += n;
    }
    pdfReadStats.bytes += done;
    return new Uint8Array(b.buffer, b.byteOffset, done);
  };
  class FileRange extends pdfjs.PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number) {
      this.onDataRange(begin, read(begin, end));
    }
  }
  // The start of the file up front: the header, and for small files everything.
  const range = new FileRange(size, read(0, Math.min(size, PDF_RANGE_CHUNK)));
  const task = pdfjs.getDocument({
    range,
    rangeChunkSize: PDF_RANGE_CHUNK,
    // Fetch only what is asked for: no background download of the rest of the file.
    disableAutoFetch: true,
    disableStream: true,
    // Untrusted input (§6.3): no font loading into the system. (pdf.js 6 no longer evaluates
    // font programs as code, so the old isEvalSupported switch is gone.)
    disableFontFace: true,
    useSystemFonts: false,
    // Images over the pixel limit are skipped by pdf.js instead of decoded (§20).
    maxImageSize: MAX_IMAGE_PIXELS,
    // pdf.js insists these end in "/" (a backslash fails on Windows); Windows accepts "/".
    standardFontDataUrl: dataDir('standard_fonts'),
    cMapUrl: dataDir('cmaps'),
    cMapPacked: true,
    verbosity: 0,
  });
  const close = async () => {
    await task.destroy();
    fs.closeSync(fd);
  };
  try {
    return { pdfjs, doc: await task.promise, task: { destroy: close } };
  } catch (err) {
    await close();
    if ((err as Error).name === 'PasswordException')
      throw new LimitError('encrypted', 'The PDF is password-protected.');
    throw err;
  }
}

const clean = (v: unknown) => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return t ? t : undefined;
};

/** Junk that PDF tools write into the Title field. */
const JUNK_TITLE =
  /^(untitled|unknown|title|document\d*|microsoft word|.*\.(docx?|pdf|indd|qxd|tex|rtf|odt))$|^microsoft word - /i;

type InfoDict = Record<string, unknown>;

function pdfMetadata(info: InfoDict, xmp: { get(k: string): unknown } | null): EmbeddedMetadata {
  const m: EmbeddedMetadata = {};
  const xmpGet = (k: string) => {
    try {
      const v = xmp?.get(k);
      return Array.isArray(v) ? clean(v[0]) : clean(v);
    } catch {
      return undefined;
    }
  };
  const title = xmpGet('dc:title') ?? clean(info.Title);
  if (title && !JUNK_TITLE.test(title)) m.title = title;
  const author = xmpGet('dc:creator') ?? clean(info.Author);
  if (author && !/^(unknown|administrator|user|owner)$/i.test(author))
    m.creators = author
      .split(/\s*;\s*/)
      .filter(Boolean)
      .map((name) => ({ name }));
  const lang = clean(info.Language) ?? xmpGet('dc:language');
  if (lang) m.language = lang.toLowerCase();
  const subjects = clean(info.Keywords)
    ?.split(/[;,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (subjects?.length) m.subjects = subjects.slice(0, 30);
  const subject = clean(info.Subject);
  if (subject) m.description = subject.slice(0, 5000);
  m.date = clean(info.CreationDate);
  m.publisher = xmpGet('dc:publisher');
  for (const k of Object.keys(m) as (keyof EmbeddedMetadata)[]) if (m[k] === undefined) delete m[k];
  return m;
}

/** Evenly spread sample pages; page 1 is skipped when there are enough others (it's a cover). */
export function samplePages(numPages: number, n = PDF_TYPE_SAMPLE_PAGES): number[] {
  const first = numPages > 3 ? 2 : 1;
  const span = numPages - first + 1;
  if (span <= n) return Array.from({ length: span }, (_, i) => first + i);
  return Array.from({ length: n }, (_, i) => first + Math.floor(((i + 0.5) * span) / n));
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

interface PageImage {
  coverage: number;
  colour: boolean | null;
}

/** Share of sampled pixels with visible colour: comics are colour, scans and manga mostly grey. */
function isColour(img: { kind?: number; data?: Uint8ClampedArray | Uint8Array }): boolean | null {
  const d = img.data;
  if (!d || !img.kind) return null;
  if (img.kind === 1) return false; // 1 bit per pixel: black and white
  const stride = img.kind === 3 ? 4 : 3;
  const pixels = Math.floor(d.length / stride);
  const step = Math.max(1, Math.floor(pixels / 4000));
  let colourful = 0;
  let seen = 0;
  for (let p = 0; p < pixels; p += step) {
    const i = p * stride;
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colourful++;
    seen++;
  }
  return seen > 0 && colourful / seen > 0.05;
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof openPdf>>['doc']['getPage']>>;

async function pageImages(pdfjs: PdfJs, page: PdfPage): Promise<PageImage[]> {
  const ops = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  const pageArea = vp.width * vp.height;
  // The viewport transform flips y; only areas matter here, so the identity is enough.
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const out: PageImage[] = [];
  const O = pdfjs.OPS;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform) ctm = mul(ctm, args as unknown as Matrix);
    else if (fn === O.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0])) ctm = mul(ctm, args[0] as Matrix);
    } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      let colour: boolean | null;
      try {
        const obj =
          fn === O.paintInlineImageXObject
            ? args[0]
            : String(args[0]).startsWith('g_')
              ? page.commonObjs.get(String(args[0]))
              : page.objs.get(String(args[0]));
        colour = isColour(obj as { kind?: number; data?: Uint8ClampedArray });
      } catch {
        colour = null;
      }
      out.push({ coverage: pageArea > 0 ? Math.min(1, area / pageArea) : 0, colour });
    }
  }
  return out;
}

export function classifyPdf(
  pages: { chars: number; images: PageImage[]; aspect: number }[],
): PdfTypeResult {
  const sampled = pages.length;
  let textPages = 0;
  let imagePages = 0;
  let colourImagePages = 0;
  let portraitPages = 0;
  for (const p of pages) {
    if (p.chars >= PDF_TEXT_PAGE_CHARS) textPages++;
    const full = p.images.find((i) => i.coverage >= PDF_FULL_PAGE_IMAGE);
    if (full) {
      imagePages++;
      if (full.colour) colourImagePages++;
    }
    if (p.aspect >= COMIC_ASPECT_MIN && p.aspect <= COMIC_ASPECT_MAX) portraitPages++;
  }
  const share = (n: number) => (sampled ? n / sampled : 0);
  const of = (n: number, what: string) => `${n} of ${sampled} sampled pages ${what}`;
  const base = { sampled, textPages, imagePages, colourImagePages, portraitPages };
  if (sampled === 0) return { ...base, type: 'uncertain', evidence: 'No pages could be sampled.' };
  if (share(imagePages) >= PDF_TYPE_MAJORITY) {
    if (share(textPages) >= PDF_TYPE_MAJORITY)
      return {
        ...base,
        type: 'scanned',
        evidence: `${of(imagePages, 'are page images')}, with a text layer (a scanned book).`,
      };
    if (
      share(textPages) < 1 - PDF_TYPE_MAJORITY &&
      share(portraitPages) >= PDF_TYPE_MAJORITY &&
      colourImagePages / imagePages >= PDF_TYPE_MAJORITY
    )
      return {
        ...base,
        type: 'comic',
        evidence: `${of(imagePages, 'are colour page images in a comic shape')}, with little text.`,
      };
    return {
      ...base,
      type: 'uncertain',
      evidence:
        `${of(imagePages, 'are page images')} (${colourImagePages} in colour), ` +
        `${textPages} with text: could be a comic, manga or a scanned book.`,
    };
  }
  if (share(textPages) >= PDF_TYPE_MAJORITY)
    return { ...base, type: 'text', evidence: `${of(textPages, 'are text')}.` };
  return {
    ...base,
    type: 'uncertain',
    evidence: `${of(textPages, 'are text')} and ${imagePages} are page images: no clear majority.`,
  };
}

export async function readPdf(
  file: string,
  wantCover = false,
): Promise<MetaResult & { jpeg?: Buffer | null }> {
  const { pdfjs, doc, task } = await openPdf(file);
  try {
    let info: InfoDict = {};
    let xmp: { get(k: string): unknown } | null = null;
    try {
      const md = await doc.getMetadata();
      info = (md.info ?? {}) as InfoDict;
      xmp = (md.metadata as unknown as { get(k: string): unknown } | null) ?? null;
    } catch {
      // Damaged metadata doesn't stop the rest.
    }
    const metadata = pdfMetadata(info, xmp);
    const numPages = doc.numPages;
    const pageText = async (page: Awaited<ReturnType<PdfDoc['getPage']>>) => {
      const tc = await page.getTextContent();
      let text = '';
      for (const it of tc.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : ' ');
      return text;
    };
    // 1. The sampled pages: type, shape, colour and whether there's a text layer at all.
    const sampleNumbers = samplePages(numPages);
    const sampled: { chars: number; images: PageImage[]; aspect: number }[] = [];
    const sampledText = new Map<number, string>();
    for (const n of sampleNumbers) {
      const page = await doc.getPage(n);
      const text = await pageText(page);
      sampledText.set(n, text);
      const vp = page.getViewport({ scale: 1 });
      sampled.push({
        chars: text.replace(/\s+/g, '').length,
        images: await pageImages(pdfjs, page),
        aspect: vp.width > 0 ? vp.height / vp.width : 0,
      });
      page.cleanup();
    }
    const pdfType = classifyPdf(sampled);
    // 2. Every page's text — but only if the samples found any. Extracting a page's text makes
    // pdf.js fetch its images too, so for a comic or an un-OCR'd scan this would read the whole
    // file off the drive to count no words. Its word count is then unknown, not zero.
    const hasTextLayer = sampled.some((p) => p.chars >= PDF_TEXT_PAGE_CHARS);
    let words = 0;
    let isbnText = '';
    if (hasTextLayer) {
      for (let n = 1; n <= numPages; n++) {
        let text = sampledText.get(n);
        if (text === undefined) {
          const page = await doc.getPage(n);
          text = await pageText(page);
          page.cleanup();
        }
        words += countWords(text);
        if (n <= PDF_ISBN_PAGES) {
          isbnText += text + '\n';
          sampledText.set(n, text);
        }
      }
    }
    // Even image-heavy comics can have a text copyright page. Read only the opening
    // pages when the broad sample found no text, never the entire comic.
    const openingPages: { label: string; text: string }[] = [];
    for (let n = 1; n <= Math.min(hasTextLayer ? PDF_ISBN_PAGES : 4, numPages); n++) {
      let text = sampledText.get(n);
      if (text === undefined) {
        const page = await doc.getPage(n);
        text = await pageText(page);
        page.cleanup();
      }
      if (!hasTextLayer) isbnText += text + '\n';
      if (text.trim()) openingPages.push({ label: `Page ${n}`, text: text.trim().slice(0, 6000) });
    }
    if (openingPages.length) metadata.openingPages = openingPages;
    const isbns = findIsbns(isbnText);
    if (isbns.length) metadata.isbnCandidates = isbns.slice(0, 20);
    // The cover from the same open document: no second pass over the file.
    let jpeg: Buffer | null | undefined;
    if (wantCover) {
      try {
        jpeg = await renderFirstPage(doc);
      } catch {
        jpeg = null; // a page that can't be drawn is no cover, not a damaged book
      }
    }
    return {
      metadata,
      wordCount: words > 0 ? words : null,
      pageCount: numPages,
      pdfType,
      jpeg,
    };
  } finally {
    await task.destroy();
  }
}

export async function pdfThumbnail(file: string): Promise<Buffer | null> {
  const { doc, task } = await openPdf(file);
  try {
    return await renderFirstPage(doc);
  } finally {
    await task.destroy();
  }
}

type PdfDoc = Awaited<ReturnType<typeof openPdf>>['doc'];

async function renderFirstPage(
  doc: PdfDoc,
  pageNumber = 1,
  maxSide = THUMBNAIL_MAX_SIDE,
): Promise<Buffer | null> {
  if (doc.numPages < 1) return null;
  const page = await doc.getPage(pageNumber);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = maxSide / Math.max(vp1.width, vp1.height, 1);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // @napi-rs/canvas stands in for the browser canvas pdf.js's types describe.
  await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport: vp }).promise;
  page.cleanup();
  return canvas.toBuffer('image/jpeg', THUMBNAIL_QUALITY);
}

/** Render only the first two physical pages; range reads avoid loading the whole PDF. */
export async function pdfPagePreviews(file: string): Promise<Buffer[]> {
  const { doc, task } = await openPdf(file);
  try {
    const pages: Buffer[] = [];
    for (let n = 1; n <= Math.min(2, doc.numPages); n++) {
      const jpeg = await renderFirstPage(doc, n, PAGE_PREVIEW_MAX_SIDE);
      if (jpeg) pages.push(jpeg);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
