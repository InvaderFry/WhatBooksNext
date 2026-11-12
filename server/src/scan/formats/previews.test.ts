import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCbz, makeCbr, makeEpub, makePdf, makeImage, makeZip } from '../../testing/fixtures.ts';
import { tempDir } from '../../testing/helpers.ts';
import { runTask } from './index.ts';
import { imageInfo } from './images.ts';

const dir = tempDir('wbn-page-render-');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
async function previews(name: string, format: string, data: Buffer) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  const result = await runTask({ kind: 'previews', file, format });
  if (result.kind !== 'previews') throw new Error('Wrong worker result');
  return result.pages;
}

describe('opening page rendering', () => {
  it.each(['cbz', 'cbr'])(
    'draws exactly two distinct comic pages in reading order (%s)',
    async (format) => {
      const pages = await previews(
        `comic.${format}`,
        format,
        format === 'cbr' ? makeCbr({ pages: 12 }) : makeCbz({ pages: 12 }),
      );
      expect(pages).toHaveLength(2);
      expect(Buffer.from(pages[0]!)).not.toEqual(Buffer.from(pages[1]!));
      for (const page of pages) expect(imageInfo(page)?.type).toBe('jpeg');
    },
  );
  it('renders the first two PDF pages at useful resolution, with no duplicate page 1', async () => {
    const pages = await previews(
      'comic.pdf',
      'pdf',
      makePdf({
        pages: [
          { image: makeImage(300, 450, 'jpeg', '#ff0000') },
          { image: makeImage(300, 450, 'jpeg', '#0000ff') },
          { text: ['This third page must not be previewed'] },
        ],
      }),
    );
    expect(pages).toHaveLength(2);
    expect(Math.max(imageInfo(pages[0]!)!.width, imageInfo(pages[0]!)!.height)).toBe(1000);
    expect(Buffer.from(pages[0]!)).not.toEqual(Buffer.from(pages[1]!));
  });
  it('returns one preview for a one-page document', async () => {
    expect(
      await previews('one.pdf', 'pdf', makePdf({ pages: [{ text: ['Only page'] }] })),
    ).toHaveLength(1);
  });
  it('renders two EPUB opening sections without treating the entire book as two pages', async () => {
    const pages = await previews('book.epub', 'epub', makeEpub({ chapters: [100, 120, 130] }));
    expect(pages).toHaveLength(2);
    expect(imageInfo(pages[0]!)).toMatchObject({ type: 'jpeg', width: 700, height: 1000 });
    expect(Buffer.from(pages[0]!)).not.toEqual(Buffer.from(pages[1]!));
  });
  it('draws local EPUB cover images but never follows an external image reference', async () => {
    const data = makeZip([
      {
        name: 'book.opf',
        data: '<package><manifest><item id="c" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="t" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/><itemref idref="t"/></spine></package>',
      },
      { name: 'cover.xhtml', data: '<html><body><img src="cover.jpg"/></body></html>' },
      { name: 'cover.jpg', data: makeImage(300, 450) },
      {
        name: 'text.xhtml',
        data: '<html><body><script>throw new Error("Never run")</script><img src="https://attacker.example/image"/><p>Opening words.</p></body></html>',
      },
    ]);
    const pages = await previews('safe.epub', 'epub', data);
    expect(pages).toHaveLength(2);
    expect(imageInfo(pages[0]!)).toMatchObject({ width: 300, height: 450 });
  });
  it('still enforces image limits on page 2', async () => {
    const huge = makeImage(2, 2, 'png');
    huge.writeUInt32BE(100000, 16);
    huge.writeUInt32BE(100000, 20);
    await expect(
      previews(
        'limited.cbz',
        'cbz',
        makeZip([
          { name: '1.jpg', data: makeImage(30, 40) },
          { name: '2.png', data: huge },
        ]),
      ),
    ).rejects.toThrow(/50 megapixels/);
  });
});
