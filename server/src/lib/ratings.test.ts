import { describe, expect, it } from 'vitest';
import { rating } from '../testing/ratings.ts';
import { item, page, series, situation } from '../testing/rank.ts';
import {
  communityRating,
  eligibleRatings,
  ratingStats,
  type RatedFrom,
  type SourceStats,
} from './ratings.ts';
import { runMode } from './modes.ts';
import { buildCard } from './recommend.ts';

// Each source's average sits below its "highly rated" line, as in a real library.
const stats = new Map<RatedFrom['source'], SourceStats>([
  ['hardcover', { mean: 75, medianVotes: 25, rated: 30, highlyRated: 80, fewVotes: 10 }],
  ['openlibrary', { mean: 75, medianVotes: 25, rated: 30, highlyRated: 80, fewVotes: 20 }],
  ['anilist', { mean: 75, medianVotes: 25, rated: 30, highlyRated: 80, fewVotes: 10 }],
]);
const select = (rs: RatedFrom[], hasSeries = false) => communityRating(rs, stats, hasSeries);

describe('rating selection, Stage 1', () => {
  it('uses 3,000 Open Library votes over 3 Hardcover votes and 5,000 over a confirmed 25', () => {
    for (const [ol, hc] of [
      [3000, 3],
      [5000, 25],
      [50000, 1000],
    ]) {
      const r = select([
        rating({ count: hc, match: 'confirmed' }),
        rating({ source: 'openlibrary', count: ol }),
      ]);
      expect(r.chosen).toMatchObject({ source: 'openlibrary', tier: 1 });
      expect(r.others).toHaveLength(1);
    }
  });

  it('cannot rescue a tie, rejection or wrong-volume match with a million votes', () => {
    const rs = (['tie', 'rejected', 'unidentified'] as const).map((match, n) =>
      rating({ sourceId: `wrong-${n}`, count: 1_000_000, match }),
    );
    const r = select([...rs, rating({ source: 'openlibrary' })]);
    expect(r.chosen?.source).toBe('openlibrary');
    expect(r.excluded.map((e) => e.why)).toEqual(['tie', 'rejected', 'unidentified']);
    expect(ratingStats(rs).size).toBe(0);
  });

  it('uses a supported volume before a series, and a supported series before a sparse volume', () => {
    const manga = rating({
      source: 'anilist',
      value: 90,
      scale: 100,
      count: 10000,
      scope: 'series',
    });
    expect(select([rating({ scope: 'volume', count: 20 }), manga], true).chosen).toMatchObject({
      source: 'hardcover',
      tier: 1,
    });
    expect(select([rating({ scope: 'volume', count: 3 }), manga], true).chosen).toMatchObject({
      source: 'anilist',
      tier: 2,
      label: 'Whole series; this volume has few ratings',
    });
    expect(select([manga], true).chosen?.label).toBe('Whole series; this volume has no rating');
    expect(select([manga]).excluded[0]?.why).toBe('no_series');
  });

  it('uses sparse item scores before sparse series scores and labels unknown counts', () => {
    const r = select(
      [rating({ count: null }), rating({ source: 'anilist', scope: 'series', count: 19 })],
      true,
    );
    expect(r.chosen).toMatchObject({ tier: 3, votes: null, label: 'Number of ratings unknown' });
    expect(select([rating({ scope: 'series', count: 0 })], true).chosen).toMatchObject({
      tier: 4,
      votes: 0,
    });
  });

  it('uses a provisional rating only without trusted ratings and never makes it a Hidden gem', () => {
    const unconfirmed = rating({ source: 'openlibrary', count: 1_000_000, match: 'provisional' });
    expect(select([rating({ count: null }), unconfirmed]).chosen?.source).toBe('hardcover');
    const r = select([rating({ value: 5, count: 8, match: 'provisional' })]).chosen!;
    expect(r).toMatchObject({ tier: 5, label: 'Unconfirmed match', hiddenGem: false });
    const i = item({
      community: r,
      identity: 'accepted',
      matchConfirmed: true,
      firstPublishYear: 1900,
    });
    for (const mode of ['read_next', 'classics', 'waiting'] as const) {
      const cards = runMode(mode, [i], situation(), page).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]?.limitations).toContain('rating is from an unconfirmed match');
    }
    expect(runMode('hidden_gems', [i], situation(), page).cards).toEqual([]);
  });

  it('orders known zero above unknown counts and breaks equal counts by the match’s own evidence', () => {
    expect(
      select([rating({ count: null }), rating({ source: 'openlibrary', count: 0 })]).chosen?.source,
    ).toBe('openlibrary');
    const hc = rating({ count: 25, matchScore: 0.99 });
    const ol = rating({ source: 'openlibrary', count: 25, matchScore: 0.91 });
    expect(select([hc, { ...ol, match: 'confirmed' }]).chosen?.source).toBe('openlibrary');
    expect(select([hc, { ...ol, strongIsbn: true }]).chosen?.source).toBe('openlibrary');
    expect(select([hc, ol]).chosen?.source).toBe('hardcover');
    expect(select([ol, { ...hc, matchScore: ol.matchScore }]).chosen?.source).toBe('hardcover');
    const a = { ...hc, match: 'provisional' as const, strongIsbn: true };
    const b = { ...ol, match: 'provisional' as const };
    expect(select([b, a]).chosen?.source).toBe('hardcover');
  });

  it('counts twelve volumes sharing one AniList target once in its source statistics', () => {
    const shared = rating({
      source: 'anilist',
      scope: 'series',
      value: 90,
      scale: 100,
      count: 1000,
    });
    const rs = [
      ...Array.from({ length: 12 }, () => shared),
      rating({ ...shared, sourceId: 'other-series', value: 70, count: 10 }),
    ];
    expect(ratingStats(rs).get('anilist')).toMatchObject({
      rated: 2,
      mean: 80,
      medianVotes: 505,
      // The bottom half of {10, 1000} is 10, below the floor of 25 ratings.
      fewVotes: 25,
    });
  });

  it('requires few known ratings at every other trusted source, while unconfirmed matches never block a gem', () => {
    const hc = rating({ count: 8 });
    const ol = rating({ source: 'openlibrary', count: 10 });
    expect(select([hc, ol]).chosen).toMatchObject({ hiddenGem: true, fewElsewhere: true });
    expect(select([hc, { ...ol, count: 3000 }]).chosen?.hiddenGem).toBe(false);
    // A popular series must also block a gem even when the supported item score wins tier 1.
    const widerStats = new Map(stats);
    widerStats.set('hardcover', { ...stats.get('hardcover')!, fewVotes: 25 });
    expect(
      communityRating(
        [rating({ count: 25 }), { ...ol, scope: 'series', count: 3000 }],
        widerStats,
        true,
      ).chosen,
    ).toMatchObject({ source: 'hardcover', hiddenGem: false });
    expect(select([hc, { ...ol, count: 3000, match: 'provisional' }]).chosen?.hiddenGem).toBe(true);
    expect(select([hc, { ...ol, count: null }]).chosen).toMatchObject({
      hiddenGem: true,
      fewElsewhere: false,
    });
    expect(select([rating({ count: null })]).chosen?.hiddenGem).toBe(false);
    // At least 3 ratings: 2 is noise, 3 can be a gem.
    expect(select([rating({ count: 2 })]).chosen?.hiddenGem).toBe(false);
    expect(select([rating({ count: 3 })]).chosen?.hiddenGem).toBe(true);
    // Few ratings, but its own score is below the source's "highly rated" line.
    expect(select([rating({ count: 8, value: 3.8 })]).chosen?.hiddenGem).toBe(false);
    const i = item({ community: select([hc, ol]).chosen });
    expect(runMode('hidden_gems', [i], situation(), page).cards[0]?.reasons.join(' ')).toContain(
      'and few elsewhere',
    );
    const manga = item({
      series: series('invented-series', 1),
      community: select([rating({ scope: 'series', count: 8 })], true).chosen,
    });
    expect(runMode('hidden_gems', [manga], situation(), page).cards).toEqual([]);
  });

  it('shows the source’s own scale, rounded for reading, without inventing a five-star scale', () => {
    const i = item({ community: select([rating({ value: 9.125, scale: 10 })]).chosen });
    expect(buildCard(i, [i], situation()).reasons.join(' ')).toContain('Rated 9.1/10');
    const ol = item({ community: select([rating({ value: 4.199519, count: 300 })]).chosen });
    expect(buildCard(ol, [ol], situation()).reasons.join(' ')).toContain('Rated 4.2/5');
    const al = item({
      series: series('invented-series', 1),
      community: select([rating({ value: 87.6, scale: 100, scope: 'series', count: 300 })], true)
        .chosen,
    });
    expect(buildCard(al, [al], situation()).reasons.join(' ')).toContain('Series rated 88/100');
  });

  it('gives a series rating one note on the card, not two', () => {
    const trusted = item({
      series: series('invented-series', 1),
      community: select(
        [
          rating({ scope: 'series', count: 300 }),
          rating({ source: 'hardcover', sourceId: 'hc-1', count: 3 }),
        ],
        true,
      ).chosen,
    });
    const limits = buildCard(trusted, [trusted], situation()).limitations;
    expect(limits.filter((l) => /whole series/i.test(l))).toEqual([
      'whole series; this volume has few ratings',
    ]);
  });

  it('leaves invalid and ineligible ratings unknown and neutral, and a personal rating still overrides', () => {
    const invalid = [
      rating({ scale: 0 }),
      rating({ value: NaN }),
      rating({ value: 6 }),
      rating({ count: -1 }),
    ];
    expect(select(invalid)).toMatchObject({ chosen: null, reason: 'no_rating' });
    expect(eligibleRatings(invalid, false).eligible).toEqual([]);
    const unknown = item({ community: select(invalid).chosen });
    expect(buildCard(unknown, [unknown], situation()).components.rating).toBe(0.5);
    for (const mode of ['classics', 'waiting', 'hidden_gems'] as const)
      expect(runMode(mode, [unknown], situation(), page).cards).toEqual([]);
    const personal = item({
      community: select([rating({ value: 1 })]).chosen,
      user: { rating: 10 },
    });
    expect(buildCard(personal, [personal], situation()).components.rating).toBe(1);
  });
});
