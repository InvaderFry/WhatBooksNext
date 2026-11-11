import { describe, expect, it } from 'vitest';
import type { MatchRow } from '../identify/lookups.ts';
import type { SourceName, SourceRecord } from '../sources/types.ts';
import { chooseDetails, type DetailMatch } from './details.ts';
import { fromEachSource, type FromEachSourceInput } from './fromEachSource.ts';
import { communityRating, ratingStats } from './ratings.ts';
import { ratingEvidence } from './ratingEvidence.ts';

// Invented books only (CLAUDE.md): nothing here names a real title.
const record = (source: SourceName, sourceId: string, over: Partial<SourceRecord> = {}) =>
  ({
    source,
    sourceId,
    title: 'The Invented Lighthouse',
    authors: ['Ada Inventa'],
    isbns: [],
    subjects: ['Invented subject'],
    ...over,
  }) as SourceRecord;

const row = (r: SourceRecord, score = 0.95, rank = 1): MatchRow => ({
  source: r.source,
  sourceId: r.sourceId,
  score,
  rank,
  evidence: { title: score, author: 'agrees', isbn: 'none', notes: [] },
  record: r,
});

function build(over: Partial<FromEachSourceInput> & { matches: MatchRow[] }) {
  const rejected = over.rejected ?? new Set<string>();
  const override = over.override ?? null;
  const evidence = ratingEvidence(over.matches, override, rejected);
  const rating = communityRating(evidence, ratingStats(evidence), false);
  const trusted: DetailMatch[] = over.matches
    .filter((m) => !rejected.has(`${m.source}:${m.sourceId}`))
    .map((m) => ({
      record: m.record,
      decision: override === `${m.source}:${m.sourceId}` ? 'confirmed' : 'accepted',
      strongIsbn: false,
      score: m.score,
    }));
  return fromEachSource({
    demo: false,
    asked: ['openlibrary', 'hardcover'],
    covering: ['openlibrary', 'hardcover'],
    configured: () => true,
    lookups: [],
    rejected,
    override,
    rating,
    details: chooseDetails({
      fallbackTitle: 'invented lighthouse',
      ownerTitle: null,
      files: [],
      storedCreators: [],
      issue: false,
      matches: trusted.filter((m) => m.score >= 0.9),
    }),
    ...over,
  });
}

describe('From each source (plan stage 3)', () => {
  it('lists every source asked, marks the rating in use with its reason, and keeps the other rating visible', () => {
    const r = build({
      matches: [
        row(
          record('openlibrary', 'ol-1', {
            rating: { value: 4.1, scale: 5, count: 3000, scope: 'book' },
          }),
        ),
        row(
          record('hardcover', 'hc-1', {
            rating: { value: 4.6, scale: 5, count: 3, scope: 'book' },
          }),
        ),
      ],
    });
    expect(r.entries.map((e) => e.source).sort()).toEqual(['hardcover', 'openlibrary']);
    const ol = r.entries.find((e) => e.source === 'openlibrary');
    const hc = r.entries.find((e) => e.source === 'hardcover');
    expect(ol!.used).toContainEqual({ field: 'rating', reason: 'Enough ratings for this book' });
    expect(hc!.used.map((u) => u.field)).not.toContain('rating');
    expect(hc!.rating).toEqual({ value: 4.6, scale: 5, count: 3, scope: 'book' });
    expect(ol!.statusText).toBe('Matched');
  });

  it('says plainly when a matched source has no rating, and when a source found nothing or failed', () => {
    const r = build({
      matches: [row(record('openlibrary', 'ol-1'))],
      asked: ['openlibrary', 'hardcover', 'anilist'],
      covering: ['openlibrary', 'hardcover', 'anilist'],
      lookups: [
        {
          source: 'openlibrary',
          outcome: 'matched',
          looked_up_at: '2026-11-01T00:00:00Z',
          error: null,
        },
        { source: 'hardcover', outcome: 'none', looked_up_at: '2026-11-01T00:00:00Z', error: null },
        {
          source: 'anilist',
          outcome: 'failed',
          looked_up_at: '2026-11-01T00:00:00Z',
          error: 'timed out',
        },
      ],
    });
    const by = Object.fromEntries(r.entries.map((e) => [e.source, e]));
    expect(by.openlibrary!.ratingNote).toBe('Open Library has no rating for this book');
    expect(by.openlibrary!.lookedUpAt).toBe('2026-11-01T00:00:00Z');
    expect(by.hardcover!.statusText).toBe('Not found on Hardcover');
    expect(by.anilist!.statusText).toBe(
      'AniList couldn’t be reached last time (timed out); will retry',
    );
  });

  it('names sources that do not cover this kind of book apart from those not set up', () => {
    const r = build({
      matches: [],
      asked: ['openlibrary'],
      covering: ['openlibrary', 'hardcover'],
      configured: (s) => s !== 'hardcover',
    });
    expect(r.notAsked).toEqual([
      { source: 'hardcover', label: 'Hardcover', why: 'not_set_up' },
      { source: 'anilist', label: 'AniList', why: 'kind' },
      { source: 'metron', label: 'Metron', why: 'kind' },
      { source: 'comicvine', label: 'ComicVine', why: 'kind' },
    ]);
    expect(r.entries.find((e) => e.source === 'openlibrary')!.statusText).toBe('Not looked up yet');
  });

  it('lists an unconfirmed match as unconfirmed, and leaves rejected candidates out', () => {
    const r = build({
      matches: [
        row(record('openlibrary', 'ol-wrong', { title: 'A Different Invented Book' }), 0.95),
        row(record('openlibrary', 'ol-maybe'), 0.75, 2),
      ],
      rejected: new Set(['openlibrary:ol-wrong']),
    });
    const ol = r.entries.find((e) => e.source === 'openlibrary')!;
    expect(ol.status).toBe('unconfirmed');
    expect(ol.statusText).toBe('Probably this book (unconfirmed)');
    expect(ol.record!.sourceId).toBe('ol-maybe');
    expect(JSON.stringify(r)).not.toContain('A Different Invented Book');
  });

  it('shows the owner’s confirmed record and marks the details taken from it', () => {
    const r = build({
      matches: [
        row(record('openlibrary', 'ol-1', { firstPublishYear: 1990, pages: 310 })),
        row(record('openlibrary', 'ol-2', { title: 'Invented Lighthouse, Revised' }), 0.94, 2),
      ],
      override: 'openlibrary:ol-1',
    });
    const ol = r.entries.find((e) => e.source === 'openlibrary')!;
    expect(ol.status).toBe('confirmed');
    expect(ol.statusText).toBe('Matched — confirmed by you');
    expect(ol.used.map((u) => u.field)).toEqual(expect.arrayContaining(['year', 'pages', 'title']));
    expect(ol.used.find((u) => u.field === 'year')!.reason).toBe(
      'Earliest year from a trusted source',
    );
  });

  it('marks every source as not used when the owner left the book unidentified', () => {
    const r = build({ matches: [row(record('openlibrary', 'ol-1'))], override: 'none' });
    expect(r.entries.find((e) => e.source === 'openlibrary')).toMatchObject({
      status: 'not_used',
      statusText: 'Not used: you chose to leave this book unidentified',
    });
  });

  it('includes a Calibre record as its own entry, explains a skipped ComicVine, and shows source text as plain text', () => {
    const r = build({
      matches: [
        row(
          record('calibre', 'cal-1', {
            description: '<p>An <b>invented</b> keeper.</p>',
            subjects: Array.from({ length: 20 }, (_, n) => `Invented tag ${n}`),
          }),
          1,
        ),
      ],
      asked: ['metron', 'comicvine'],
      covering: ['metron', 'comicvine'],
      lookups: [
        {
          source: 'comicvine',
          outcome: 'skipped',
          looked_up_at: '2026-11-01T00:00:00Z',
          error: null,
        },
      ],
    });
    const cal = r.entries.find((e) => e.source === 'calibre')!;
    expect(cal.statusText).toBe('From your Calibre library');
    expect(cal.record!.description).toBe('An invented keeper.');
    expect(cal.record!.subjects).toHaveLength(12);
    expect(r.entries.find((e) => e.source === 'comicvine')!.statusText).toBe(
      'Not asked: Metron already answered for this issue',
    );
  });

  it('names no unasked sources in the demo, which uses only invented data', () => {
    expect(
      build({ matches: [], demo: true, asked: ['demo'], covering: ['demo'] }).notAsked,
    ).toEqual([]);
  });
});
