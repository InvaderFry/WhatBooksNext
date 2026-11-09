import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  makeCbr,
  makeCbz,
  makeEpub,
  makeImage,
  makePdf,
  makeZip,
  textLines,
} from '../../testing/fixtures.ts';
import { tempDir } from '../../testing/helpers.ts';
import { comicInfoMetadata, notAComicReason } from './comic.ts';
import { imageInfo } from './images.ts';
import { runTask } from './index.ts';
import { classifyPdf, samplePages } from './pdf.ts';
import { countWords, findIsbns, htmlToText } from './text.ts';
import { findAll, parseXml, textOf } from './xml.ts';
import { checkArchiveLimits } from './zip.ts';

const dir = tempDir('wbn-formats-');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, data: Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
};
const meta = async (file: string, format: string, ext = format) => {
  const r = await runTask({ kind: 'meta', file, format, ext });
  if (r.kind !== 'meta') throw new Error('wrong result');
  return r;
};
const thumb = async (file: string, format: string) => {
  const r = await runTask({ kind: 'thumb', file, format });
  if (r.kind !== 'thumb') throw new Error('wrong result');
  return r.jpeg;
};

/** The colour at a point of a JPEG thumbnail, to prove the cover was really drawn. */
async function pixelAt(jpeg: Uint8Array, fx: number, fy: number): Promise<number[]> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(Buffer.from(jpeg));
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return [...g.getImageData(Math.floor(img.width * fx), Math.floor(img.height * fy), 1, 1).data];
}

describe('XML reader', () => {
  it('reads elements, attributes, entities and CDATA, ignoring a DOCTYPE', () => {
    const doc = parseXml(
      '<!DOCTYPE x [<!ENTITY boom "aaaa">]><a x="1 &amp; 2"><b>Tom &amp; Jerry</b><b><![CDATA[<raw>]]></b><c/></a>',
    );
    const bs = findAll(doc, 'b');
    expect(bs.map(textOf)).toEqual(['Tom & Jerry', '<raw>']);
    expect(findAll(doc, 'a')[0]!.attrs.x).toBe('1 & 2');
  });

  it('never throws on broken markup', () => {
    expect(() => parseXml('<a><b>unclosed <c attr="x>')).not.toThrow();
    expect(() => parseXml('<'.repeat(10_000))).not.toThrow();
  });
});

describe('text helpers', () => {
  it('counts words in visible text only', () => {
    const t = htmlToText(
      '<html><head><title>No</title><style>p{}</style></head><body><p>One two&nbsp;three</p><script>var x</script></body></html>',
    );
    expect(t).toBe('One two three');
    expect(countWords(t)).toBe(3);
  });

  it('counts words in unspaced scripts with the word segmenter', () => {
    expect(countWords('私は本を読みます')).toBeGreaterThan(2);
  });

  it('finds valid ISBNs only, as ISBN-13 candidates', () => {
    expect(findIsbns('ISBN 978-0-306-40615-7 and 0-306-40615-2, not 978-0-306-40615-8')).toEqual([
      '9780306406157',
    ]);
  });
});

describe('image headers', () => {
  it('reads sizes from JPEG and PNG headers without decoding', () => {
    expect(imageInfo(makeImage(160, 245, 'jpeg'))).toEqual({
      type: 'jpeg',
      width: 160,
      height: 245,
    });
    expect(imageInfo(makeImage(30, 40, 'png'))).toEqual({ type: 'png', width: 30, height: 40 });
  });
});

describe('archive limits', () => {
  it('refuses an archive that expands past the ratio limit, before inflating it', () => {
    expect(() =>
      checkArchiveLimits([{ name: 'bomb', size: 500 * 1024 * 1024, compressedSize: 1024 * 1024 }]),
    ).toThrow(/100:1/);
  });

  it('refuses an archive that expands past 4 GB', () => {
    expect(() =>
      checkArchiveLimits([
        { name: 'a', size: 3 * 1024 ** 3, compressedSize: 3 * 1024 ** 3 },
        { name: 'b', size: 2 * 1024 ** 3, compressedSize: 2 * 1024 ** 3 },
      ]),
    ).toThrow(/4 GB/);
  });

  it('reports a real zip bomb as a limit problem', async () => {
    const bomb = put(
      'bomb.zip',
      makeZip([{ name: 'zeros.jpg', data: Buffer.alloc(30 * 1024 * 1024) }]),
    );
    await expect(meta(bomb, 'cbz', 'zip')).rejects.toThrow(/100:1/);
  });
});

describe('EPUB', () => {
  it('reads OPF metadata, calibre series and a word count that skips navigation', async () => {
    const f = put(
      'book.epub',
      makeEpub({
        title: 'The Boat of Lanterns',
        creators: ['Ada Quill'],
        language: 'en',
        publisher: 'Invented Press',
        identifiers: ['urn:isbn:9780306406157'],
        subjects: ['Fiction'],
        description: '<p>A <b>tale</b>.</p><script>x</script>',
        series: 'Lantern Cycle',
        seriesIndex: '2',
        chapters: [1000, 2000],
        cover: true,
      }),
    );
    const r = await meta(f, 'epub');
    expect(r.meta.metadata).toMatchObject({
      title: 'The Boat of Lanterns',
      creators: [{ name: 'Ada Quill', role: 'aut' }],
      language: 'en',
      publisher: 'Invented Press',
      identifiers: [{ scheme: 'isbn', value: '9780306406157' }],
      series: 'Lantern Cycle',
      seriesIndex: '2',
      description: 'A tale .',
    });
    // Two chapters of 1,000 and 2,000 words (headings included); the nav page isn't counted.
    expect(r.meta.wordCount).toBe(3000);
    expect(r.partialHash).toMatch(/^[0-9a-f]{64}$/);
    const jpeg = await thumb(f, 'epub');
    expect(imageInfo(jpeg!)).toMatchObject({ type: 'jpeg', height: 320 });
    // The cover's top panel is #2a6f97 (42, 111, 151): drawn, not a blank page.
    const [red, green, blue] = await pixelAt(jpeg!, 0.5, 0.2);
    expect(Math.abs(red! - 42) + Math.abs(green! - 111) + Math.abs(blue! - 151)).toBeLessThan(40);
  });

  it('reads an EPUB 3 belongs-to-collection series', async () => {
    const f = put(
      'e3.epub',
      makeEpub({ title: 'X', series: 'Salt Roads', seriesIndex: '3', epub3Collection: true }),
    );
    expect((await meta(f, 'epub')).meta.metadata).toMatchObject({
      series: 'Salt Roads',
      seriesIndex: '3',
    });
  });

  it('fails cleanly on a file that is not an EPUB', async () => {
    const f = put('junk.epub', Buffer.from('not a zip at all'));
    await expect(meta(f, 'epub')).rejects.toThrow();
  });
});

describe('comic archives', () => {
  const info = {
    Series: 'Copperline',
    Number: '3',
    Volume: '2019',
    Writer: 'Ada Quill',
    Manga: 'YesAndRightToLeft',
    PageCount: '12',
  };

  it('reads ComicInfo.xml and counts pages from a CBZ', async () => {
    const f = put('c.cbz', makeCbz({ pages: 12, comicInfo: info }));
    const r = await meta(f, 'cbz');
    expect(r.meta.pageCount).toBe(12);
    expect(r.meta.metadata.comic).toMatchObject({
      series: 'Copperline',
      number: '3',
      manga: 'yes_rtl',
    });
    expect(r.meta.metadata.creators).toEqual([{ name: 'Ada Quill', role: 'writer' }]);
  });

  it('reads a CBR (RAR) the same way', async () => {
    const f = put('c.cbr', makeCbr({ pages: 5, comicInfo: info }));
    const r = await meta(f, 'cbr');
    expect(r.meta.pageCount).toBe(5);
    expect(r.meta.metadata.series).toBe('Copperline');
    expect(imageInfo((await thumb(f, 'cbr'))!)?.type).toBe('jpeg');
  });

  it('reads a ".cbr" that is really a ZIP, as comic readers do', async () => {
    const f = put('mislabelled.cbr', makeCbz({ pages: 7, comicInfo: info }));
    const r = await meta(f, 'cbr');
    expect(r.meta.pageCount).toBe(7);
    expect(r.meta.metadata.series).toBe('Copperline');
    expect(await thumb(f, 'cbr')).not.toBeNull();
  });

  it('reads a ".cbz" that is really a RAR', async () => {
    const f = put('mislabelled.cbz', makeCbr({ pages: 4 }));
    expect((await meta(f, 'cbz')).meta.pageCount).toBe(4);
  });

  it('lists a 7-Zip archive by name only instead of calling it damaged', async () => {
    const f = put(
      'seven.cbr',
      Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(200)]),
    );
    expect((await meta(f, 'cbr')).meta).toEqual({ metadata: {}, wordCount: null, pageCount: null });
    expect(await thumb(f, 'cbr')).toBeNull();
  });

  it('still reports a file that is no archive at all as damaged', async () => {
    const f = put('junk.cbr', Buffer.from('this was never an archive, just text'));
    await expect(meta(f, 'cbr')).rejects.toThrow();
  });

  it('uses the first page in natural order as the cover', async () => {
    // Page 1's top panel is purple (#8e44ad); the others are red. Pages are stored 12, 11, … 1.
    const f = put('order.cbz', makeCbz({ pages: 12 }));
    const [r, g, b] = await pixelAt((await thumb(f, 'cbz'))!, 0.5, 0.2);
    expect(Math.abs(r! - 0x8e) + Math.abs(g! - 0x44) + Math.abs(b! - 0xad)).toBeLessThan(40);
  });

  it('says a .zip of documents is not a comic', async () => {
    const f = put(
      'bundle.zip',
      makeZip([
        { name: 'setup.exe', data: Buffer.alloc(100, 1) },
        { name: 'readme.pdf', data: Buffer.alloc(100, 2) },
        { name: 'icon.png', data: makeImage(20, 20, 'png') },
      ]),
    );
    const r = await meta(f, 'cbz', 'zip');
    expect(r.meta.notComic).toMatch(/only one image/);
  });

  it('ignores sidecar files when judging whether an archive is a comic', () => {
    const e = (name: string) => ({ name, size: 1, compressedSize: 1 });
    expect(notAComicReason([e('1.jpg'), e('2.jpg'), e('ComicInfo.xml'), e('scan.nfo')])).toBeNull();
    expect(notAComicReason([e('1.jpg'), e('2.jpg'), e('a.mp3'), e('b.mp3')])).toMatch(/2 of its 4/);
  });

  it('reads ComicInfo even with odd case and missing fields', () => {
    expect(comicInfoMetadata('<comicinfo><series>Iron Harbor</series></comicinfo>')).toMatchObject({
      series: 'Iron Harbor',
    });
  });
});

describe('PDF', () => {
  it('reads Info metadata, page and word counts, ISBN candidates, and calls a text PDF text', async () => {
    const f = put(
      'text.pdf',
      makePdf({
        pages: [
          { text: ['Widget Patterns', 'ISBN 978-0-306-40615-7', ...textLines(30, 1)] },
          { text: textLines(40, 2) },
          { text: textLines(40, 3) },
          { text: textLines(40, 4) },
        ],
        info: { Title: 'Widget Patterns', Author: 'Ada Quill' },
      }),
    );
    const r = await meta(f, 'pdf');
    expect(r.meta.pageCount).toBe(4);
    expect(r.meta.wordCount).toBeGreaterThan(1500);
    expect(r.meta.metadata).toMatchObject({
      title: 'Widget Patterns',
      creators: [{ name: 'Ada Quill' }],
      isbnCandidates: ['9780306406157'],
    });
    expect(r.meta.pdfType?.type).toBe('text');
    expect(imageInfo((await thumb(f, 'pdf'))!)?.type).toBe('jpeg');
  });

  it('ignores junk titles written by PDF tools', async () => {
    const f = put(
      'junk.pdf',
      makePdf({ pages: [{ text: ['x'] }], info: { Title: 'Microsoft Word - draft3.docx' } }),
    );
    expect((await meta(f, 'pdf')).meta.metadata.title).toBeUndefined();
  });

  it('calls colour full-page images in a portrait shape a comic', async () => {
    const page = { image: makeImage(400, 615) };
    const f = put(
      'comic.pdf',
      makePdf({ pages: [page, page, page, page, page], width: 400, height: 615 }),
    );
    expect((await meta(f, 'pdf')).meta.pdfType).toMatchObject({ type: 'comic', imagePages: 4 });
  });

  it('calls page images with a text layer a scanned book', async () => {
    const page = {
      image: makeImage(500, 700, 'jpeg', '#000', true),
      imageGray: true,
      hiddenText: textLines(),
    };
    const f = put('scan.pdf', makePdf({ pages: [page, page, page, page] }));
    expect((await meta(f, 'pdf')).meta.pdfType?.type).toBe('scanned');
  });

  it('leaves grey page images with no text uncertain: manga or a scan without OCR', async () => {
    const page = { image: makeImage(400, 615, 'jpeg', '#000', true), imageGray: true };
    const f = put(
      'grey.pdf',
      makePdf({ pages: [page, page, page, page], width: 400, height: 615 }),
    );
    const t = (await meta(f, 'pdf')).meta.pdfType!;
    expect(t.type).toBe('uncertain');
    expect(t.evidence).toMatch(/could be a comic, manga or a scanned book/);
  });

  it('leaves a mixed PDF uncertain rather than forcing a type', () => {
    const img = [{ coverage: 1, colour: true }];
    const pages = [
      { chars: 900, images: [], aspect: 1.3 },
      { chars: 900, images: [], aspect: 1.3 },
      { chars: 0, images: img, aspect: 1.5 },
      { chars: 0, images: img, aspect: 1.5 },
    ];
    expect(classifyPdf(pages).type).toBe('uncertain');
  });

  it('samples pages spread through the document, skipping the cover', () => {
    expect(samplePages(3)).toEqual([1, 2, 3]);
    expect(samplePages(500, 4)).toEqual([64, 189, 313, 438]);
  });
});
