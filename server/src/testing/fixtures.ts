import { createCanvas } from '@napi-rs/canvas';
import zlib from 'node:zlib';

/**
 * Generators for FICTIONAL book files (PLAN.md §17): EPUB, CBZ, CBR and PDF, built in code so
 * the tests and the demo need no third-party files. Every title, name and word is invented.
 */

// ---- ZIP (stored or deflated) --------------------------------------------------------------------

export interface ZipEntryInput {
  name: string;
  data: Buffer | string;
  /** Store without compression (EPUB's mimetype must be stored). */
  store?: boolean;
}

/** A minimal ZIP writer: local headers, central directory, end record. No Zip64. */
export function makeZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const packed = e.store ? raw : zlib.deflateRawSync(raw);
    const method = e.store ? 0 : 8;
    const crc = zlib.crc32(raw);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- RAR 4 (stored) -------------------------------------------------------------------------------

/**
 * A minimal RAR 4.x writer using method 0x30 ("store", no compression), following the public
 * RAR 2.9–4.x technical note: marker block, archive header, one file header per entry. Enough
 * for a CBR fixture; real RAR compression is proprietary and not needed to test the reader.
 */
export function makeRar(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];
  const block = (type: number, flags: number, body: Buffer): Buffer => {
    const head = Buffer.alloc(7 + body.length);
    head.writeUInt8(type, 2);
    head.writeUInt16LE(flags, 3);
    head.writeUInt16LE(7 + body.length, 5);
    body.copy(head, 7);
    head.writeUInt16LE(zlib.crc32(head.subarray(2)) & 0xffff, 0);
    return head;
  };
  parts.push(block(0x73, 0, Buffer.alloc(6)));
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const body = Buffer.alloc(25 + name.length);
    body.writeUInt32LE(e.data.length, 0); // packed size
    body.writeUInt32LE(e.data.length, 4); // unpacked size
    body.writeUInt8(2, 8); // host OS: Windows
    body.writeUInt32LE(zlib.crc32(e.data), 9);
    body.writeUInt32LE(0x5a210000, 13); // DOS time, any valid value
    body.writeUInt8(29, 17); // version needed (2.9)
    body.writeUInt8(0x30, 18); // method: store
    body.writeUInt16LE(name.length, 19);
    body.writeUInt32LE(0x20, 21); // attributes: archive
    name.copy(body, 25);
    // 0x8000: LONG_BLOCK (data follows the header); 0x00e0 would mark a directory.
    parts.push(block(0x74, 0x8000, body), e.data);
  }
  parts.push(block(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---- Invented text ---------------------------------------------------------------------------

const SYLLABLES = ['lo', 'ra', 'ven', 'mi', 'tor', 'sa', 'quel', 'an', 'dri', 'po', 'eth', 'ul'];

/** Deterministic invented prose: `count` words of made-up syllables, in sentences. */
export function inventedWords(count: number, seed = 1): string {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + (rnd() % 3);
    let w = '';
    for (let j = 0; j < n; j++) w += SYLLABLES[rnd() % SYLLABLES.length];
    words.push(i % 12 === 11 ? `${w}.` : w);
  }
  return words.join(' ');
}

// ---- EPUB -------------------------------------------------------------------------------------

export interface EpubOptions {
  title?: string;
  creators?: string[];
  language?: string;
  publisher?: string;
  date?: string;
  identifiers?: string[];
  subjects?: string[];
  description?: string;
  series?: string;
  seriesIndex?: string;
  /** EPUB 3 belongs-to-collection instead of calibre:series. */
  epub3Collection?: boolean;
  /** Words per chapter (chapters are generated). */
  chapters?: number[];
  cover?: boolean;
  seed?: number;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function makeEpub(o: EpubOptions = {}): Buffer {
  const chapters = o.chapters ?? [1200, 1500];
  const meta: string[] = [];
  if (o.title) meta.push(`<dc:title>${esc(o.title)}</dc:title>`);
  for (const c of o.creators ?? []) meta.push(`<dc:creator opf:role="aut">${esc(c)}</dc:creator>`);
  if (o.language) meta.push(`<dc:language>${o.language}</dc:language>`);
  if (o.publisher) meta.push(`<dc:publisher>${esc(o.publisher)}</dc:publisher>`);
  if (o.date) meta.push(`<dc:date>${o.date}</dc:date>`);
  (o.identifiers ?? []).forEach((id, i) =>
    meta.push(`<dc:identifier id="id${i}">${esc(id)}</dc:identifier>`),
  );
  for (const s of o.subjects ?? []) meta.push(`<dc:subject>${esc(s)}</dc:subject>`);
  if (o.description) meta.push(`<dc:description>${esc(o.description)}</dc:description>`);
  if (o.series && o.epub3Collection) {
    meta.push(
      `<meta property="belongs-to-collection" id="c1">${esc(o.series)}</meta>`,
      `<meta refines="#c1" property="collection-type">series</meta>`,
    );
    if (o.seriesIndex)
      meta.push(`<meta refines="#c1" property="group-position">${o.seriesIndex}</meta>`);
  } else if (o.series) {
    meta.push(`<meta name="calibre:series" content="${esc(o.series)}"/>`);
    if (o.seriesIndex) meta.push(`<meta name="calibre:series_index" content="${o.seriesIndex}"/>`);
  }
  if (o.cover) meta.push('<meta name="cover" content="cover-img"/>');

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  ];
  const spine: string[] = [];
  const files: ZipEntryInput[] = [];
  chapters.forEach((n, i) => {
    manifest.push(`<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    files.push({
      name: `OEBPS/text/ch${i}.xhtml`,
      data: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title><style>p{margin:0}</style></head><body><h1>Chapter ${i + 1}</h1><p>${inventedWords(n - 2, (o.seed ?? 1) + i)}</p></body></html>`,
    });
  });
  if (o.cover) {
    manifest.push('<item id="cover-img" href="images/cover.png" media-type="image/png"/>');
    files.push({ name: 'OEBPS/images/cover.png', data: makeImage(300, 450, 'png', '#2a6f97') });
  }
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">${meta.join('')}</metadata>
<manifest>${manifest.join('')}</manifest>
<spine>${spine.join('')}</spine>
</package>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    { name: 'OEBPS/content.opf', data: opf },
    {
      name: 'OEBPS/nav.xhtml',
      data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol>${chapters.map((_, i) => `<li>Chapter ${i + 1} contents navigation entry</li>`).join('')}</ol></nav></body></html>`,
    },
    ...files,
  ]);
}

// ---- Images and comics ---------------------------------------------------------------------------

/** A simple invented "page": a coloured panel layout. Grayscale when `gray` is set. */
export function makeImage(
  width: number,
  height: number,
  format: 'png' | 'jpeg' = 'jpeg',
  color = '#c0392b',
  gray = false,
): Buffer {
  const c = createCanvas(width, height);
  const g = c.getContext('2d');
  g.fillStyle = gray ? '#eeeeee' : '#fdf6e3';
  g.fillRect(0, 0, width, height);
  g.fillStyle = gray ? '#555555' : color;
  const pad = Math.round(width * 0.05);
  g.fillRect(pad, pad, width - 2 * pad, Math.round(height * 0.4));
  g.fillStyle = gray ? '#999999' : '#2c3e50';
  g.fillRect(pad, Math.round(height * 0.5), width - 2 * pad, Math.round(height * 0.45));
  return format === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 80);
}

export interface ComicOptions {
  pages?: number;
  width?: number;
  height?: number;
  comicInfo?: Record<string, string>;
  /** Extra non-image entries, e.g. to make an archive that isn't a comic. */
  extra?: ZipEntryInput[];
}

export function comicInfoXml(fields: Record<string, string>): string {
  return `<?xml version="1.0"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${Object.entries(
    fields,
  )
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join('')}</ComicInfo>`;
}

function comicEntries(o: ComicOptions): ZipEntryInput[] {
  const pages = o.pages ?? 4;
  const entries: ZipEntryInput[] = [];
  // Out of order on purpose: the reader must sort pages naturally (page 10 after page 9).
  for (let i = pages; i >= 1; i--) {
    entries.push({
      name: `pages/page ${i}.jpg`,
      data: makeImage(o.width ?? 160, o.height ?? 245, 'jpeg', i === 1 ? '#8e44ad' : '#c0392b'),
      store: true,
    });
  }
  if (o.comicInfo) entries.push({ name: 'ComicInfo.xml', data: comicInfoXml(o.comicInfo) });
  return [...entries, ...(o.extra ?? [])];
}

export function makeCbz(o: ComicOptions = {}): Buffer {
  return makeZip(comicEntries(o));
}

export function makeCbr(o: ComicOptions = {}): Buffer {
  return makeRar(
    comicEntries(o).map((e) => ({
      name: e.name.replace(/\//g, '\\'),
      data: typeof e.data === 'string' ? Buffer.from(e.data) : e.data,
    })),
  );
}

// ---- PDF -----------------------------------------------------------------------------------------

export interface PdfPage {
  /** Visible text lines (Helvetica). */
  text?: string[];
  /** Invisible text (render mode 3), like an OCR layer under a scan. */
  hiddenText?: string[];
  /** A JPEG drawn over the whole page. */
  image?: Buffer;
  imageGray?: boolean;
}

export interface PdfOptions {
  pages: PdfPage[];
  width?: number;
  height?: number;
  info?: Record<string, string>;
}

function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < jpeg.length) {
    const marker = jpeg[i + 1]!;
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('not a JPEG');
}

const pdfStr = (s: string) => `(${s.replace(/[\\()]/g, (m) => '\\' + m)})`;

/** A small hand-built PDF 1.4: text pages, full-page image pages, or both. */
export function makePdf(o: PdfOptions): Buffer {
  const w = o.width ?? 612;
  const h = o.height ?? 792;
  const objects: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const p of o.pages) {
    let content = '';
    let resources = `/Font << /F1 ${font} 0 R >>`;
    if (p.image) {
      const { width, height } = jpegSize(p.image);
      const cs = p.imageGray ? '/DeviceGray' : '/DeviceRGB';
      const img = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.image.length} >>\nstream\n`,
          ),
          p.image,
          Buffer.from('\nendstream'),
        ]),
      );
      resources += ` /XObject << /Im1 ${img} 0 R >>`;
      content += `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q\n`;
    }
    const lines = (mode: number, text: string[]) => {
      let s = `BT /F1 11 Tf ${mode} Tr 14 TL 50 ${h - 60} Td\n`;
      for (const t of text) s += `${pdfStr(t)} Tj T*\n`;
      return s + 'ET\n';
    };
    if (p.text) content += lines(0, p.text);
    if (p.hiddenText) content += lines(3, p.hiddenText);
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << ${resources} >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let info = 0;
  if (o.info) {
    info = add(
      `<< ${Object.entries(o.info)
        .map(([k, v]) => `/${k} ${pdfStr(v)}`)
        .join(' ')} >>`,
    );
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pos);
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(b);
    pos += b.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** Lines of invented text filling a page. */
export function textLines(lines = 40, seed = 1): string[] {
  return Array.from({ length: lines }, (_, i) => inventedWords(12, seed * 100 + i));
}
