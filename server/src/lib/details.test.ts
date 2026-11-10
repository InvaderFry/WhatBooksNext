import { describe, expect, it } from 'vitest';
import { item, rated, situation, page } from '../testing/rank.ts';
import { runMode } from './modes.ts';
import { chooseDetails, displayDetailTitle } from './details.ts';

import { detailMatch, detailFile, detailInput } from '../testing/details.ts';

// All names, source ids and claims in these fixtures are invented.
describe('best details, Stage 2', () => {
  it('never takes a fact from a provisional match', () => {
    const m = detailMatch(
      { decision: 'provisional' },
      { firstPublishYear: 1900, pages: 400, description: 'Not confirmed.' },
    );
    const d = chooseDetails(detailInput({ matches: [m] }));
    expect(displayDetailTitle(d)).toBe('copperobservatory');
    expect(d).toMatchObject({
      creators: null,
      firstPublishYear: null,
      pages: null,
      description: null,
      subjects: [],
    });
    expect(d.suggestions).toEqual([m]);
  });

  it('never treats a tie, rejection or unidentified candidate as trusted', () => {
    for (const decision of ['tie', 'rejected', 'unidentified'] as const) {
      const d = chooseDetails(
        detailInput({
          matches: [
            detailMatch(
              { decision },
              { pages: 999, firstPublishYear: 1800, description: 'Wrong book' },
            ),
          ],
        }),
      );
      expect(d).toMatchObject({
        creators: null,
        firstPublishYear: null,
        pages: null,
        description: null,
        subjects: [],
      });
      expect(d.title.source).toBe('filename');
    }
  });

  it('keeps the owner’s title, then Calibre, then embedded metadata, then a trusted source and finally the filename', () => {
    const calibre = detailMatch(
      {},
      {
        source: 'calibre',
        sourceId: 'invented-calibre',
        title: 'Calibre Title',
        subtitle: 'Curated Subtitle',
        authors: ['Calibre Writer'],
      },
    );
    const online = detailMatch({}, { title: 'Online Title', subtitle: 'Online Subtitle' });
    const input = detailInput({
      ownerTitle: 'Owner Title',
      files: [detailFile()],
      matches: [online, calibre],
    });
    expect(chooseDetails(input).title).toMatchObject({
      source: 'owner',
      value: { title: 'Owner Title', subtitle: null },
    });
    expect(chooseDetails({ ...input, ownerTitle: null }).title).toMatchObject({
      source: 'calibre',
      value: { title: 'Calibre Title', subtitle: 'Curated Subtitle' },
    });
    expect(chooseDetails({ ...input, ownerTitle: null, matches: [online] }).title.source).toBe(
      'file',
    );
    expect(
      chooseDetails({ ...input, ownerTitle: null, files: [], matches: [online] }).title.value,
    ).toEqual({ title: 'Online Title', subtitle: 'Online Subtitle' });
    expect(chooseDetails(detailInput()).title.source).toBe('filename');
  });

  it('chooses creators independently: Calibre, file metadata, then a trusted match', () => {
    const online = detailMatch({}, { authors: ['Online Writer'] });
    const calibre = detailMatch({}, { source: 'calibre', authors: ['Curated Writer'] });
    const input = detailInput({ files: [detailFile()], matches: [online, calibre] });
    expect(chooseDetails(input).creators?.value).toEqual([{ name: 'Curated Writer' }]);
    expect(chooseDetails({ ...input, matches: [online] }).creators?.value).toEqual(
      detailFile().creators,
    );
    expect(chooseDetails({ ...input, files: [], matches: [online] }).creators?.value).toEqual([
      { name: 'Online Writer' },
    ]);
  });

  it('breaks trusted-source disagreements by confirmation, this source’s ISBN, score, then the specified source order', () => {
    const hc = detailMatch({}, { title: 'Hardcover Title', subtitle: 'Same Record' });
    const ol = detailMatch(
      {},
      {
        source: 'openlibrary',
        sourceId: 'invented-ol',
        title: 'Library Title',
        subtitle: 'Library Subtitle',
      },
    );
    expect(chooseDetails(detailInput({ matches: [ol, hc] })).title.source).toBe('hardcover');
    for (const over of [
      { decision: 'confirmed' as const },
      { strongIsbn: true },
      { score: 0.99 },
    ]) {
      const d = chooseDetails(detailInput({ matches: [hc, { ...ol, ...over }] }));
      expect(d.title).toMatchObject({
        source: 'openlibrary',
        value: { title: 'Library Title', subtitle: 'Library Subtitle' },
      });
      expect(displayDetailTitle(d)).toBe('Library Title: Library Subtitle');
    }
  });

  it('uses measured pages before sources, then a file-ISBN match before a stronger match', () => {
    const hc = detailMatch({ decision: 'confirmed' }, { pages: 500 });
    const ol = detailMatch(
      {},
      { source: 'openlibrary', sourceId: 'invented-ol', pages: 240, isbns: ['9780000000002'] },
    );
    const file = detailFile({
      metadata: { identifiers: [{ scheme: 'isbn', value: '978-0-000000-00-2' }] },
    });
    const input = detailInput({ files: [file], matches: [hc, ol] });
    expect(chooseDetails(input).pages).toMatchObject({
      value: 120,
      measured: true,
      source: 'file',
    });
    expect(chooseDetails({ ...input, files: [{ ...file, pages: null }] }).pages).toMatchObject({
      value: 240,
      measured: false,
      source: 'openlibrary',
      reason: 'file_isbn',
    });
    expect(chooseDetails({ ...input, files: [] }).pages?.value).toBe(500);
  });

  it('uses only trusted first-publication years and preserves disagreements of more than a year', () => {
    const input = detailInput({
      matches: [
        detailMatch({}, { firstPublishYear: 2001 }),
        detailMatch({}, { source: 'openlibrary', firstPublishYear: 1990 }),
        detailMatch({ decision: 'provisional' }, { source: 'anilist', firstPublishYear: 1800 }),
      ],
    });
    const d = chooseDetails(input);
    expect(d.firstPublishYear?.value).toBe(1990);
    expect(d.years.map((y) => y.value)).toEqual([1990, 2001]);
    expect(d.yearDisagreement).toBe(true);
    expect(
      chooseDetails(
        detailInput({
          matches: [
            detailMatch({}, { firstPublishYear: 2000 }),
            detailMatch({}, { source: 'openlibrary', firstPublishYear: 2001 }),
          ],
        }),
      ).yearDisagreement,
    ).toBe(false);
  });

  it('uses a single issue’s cover year and never the series’ start or a book source’s series year', () => {
    const issue = detailMatch(
      {},
      {
        source: 'metron',
        sourceId: 'invented-issue',
        format: 'ISSUE',
        firstPublishYear: 2019,
        series: { name: 'Copper Observatory', startYear: 1980 },
      },
    );
    const d = chooseDetails(
      detailInput({
        issue: true,
        files: [detailFile({ metadata: { comic: { year: '2019', volume: '1980' } } })],
        matches: [issue, detailMatch({}, { firstPublishYear: 1980 })],
      }),
    );
    expect(d.firstPublishYear?.value).toBe(2019);
    expect(d.years.every((y) => y.value === 2019)).toBe(true);
    expect(
      chooseDetails(
        detailInput({ issue: true, matches: [detailMatch({}, { firstPublishYear: 1980 })] }),
      ).firstPublishYear,
    ).toBeNull();
  });

  it('compares Calibre HTML as plain text and prefers a useful Hardcover description before the longest', () => {
    const padding = `<p>${'<span>'.repeat(100)}short${'</span>'.repeat(100)}</p><script>bad()</script>`;
    const calibre = detailMatch({}, { source: 'calibre', description: padding });
    const hc = detailMatch({}, { description: '**A trusted description**. '.repeat(12) });
    const ol = detailMatch(
      {},
      { source: 'openlibrary', description: 'A longer description. '.repeat(40) },
    );
    const d = chooseDetails(detailInput({ matches: [calibre, hc, ol] }));
    expect(d.description?.source).toBe('hardcover');
    expect(d.description?.value).not.toMatch(/<|\*\*|bad\(\)/);
    expect(chooseDetails(detailInput({ matches: [calibre, ol] })).description?.source).toBe(
      'openlibrary',
    );
    expect(chooseDetails(detailInput({ matches: [calibre] })).description?.value).toBe('short');
  });

  it('shows deduplicated subjects with every trusted/file provenance, without accepting provisional tags', () => {
    const d = chooseDetails(
      detailInput({
        files: [detailFile({ metadata: { subjects: ['Astronomy', 'Local tag'] } })],
        matches: [
          detailMatch(),
          detailMatch({}, { source: 'openlibrary', subjects: ['astronomy'] }),
          detailMatch({ decision: 'provisional' }, { subjects: ['Wrong tag'] }),
        ],
      }),
    );
    expect(d.subjects.map((s) => s.value)).toEqual(['Astronomy', 'Local tag']);
    expect(d.subjects[0]?.sources.map((s) => s.source)).toEqual([
      'file',
      'hardcover',
      'openlibrary',
    ]);
  });
  it('keeps author variety based on ranking creators when display bylines change', () => {
    const all = ['A', 'B', 'C'].map((title, n) =>
      item({
        title,
        creators: [{ name: n < 2 ? 'Original Writer' : 'Other Writer' }],
        community: rated(90),
      }),
    );
    const before = runMode('read_next', all, situation(), page).cards.map((c) => c.id);
    const after = runMode(
      'read_next',
      all.map((i) => ({ ...i, displayCreators: [{ name: 'New Display Writer' }] })),
      situation(),
      page,
    ).cards;
    expect(after.map((c) => c.id)).toEqual(before);
    expect(after.every((c) => c.creators[0]?.name === 'New Display Writer')).toBe(true);
  });
});
