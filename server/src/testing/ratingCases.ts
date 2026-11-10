import type { RatedFrom } from '../lib/ratings.ts';
import { rating } from './ratings.ts';
import { item, series } from './rank.ts';

/** Invented comparison corpus, including shared series scores and the plan's vote comparisons. */
export function ratingCases() {
  const cases: { item: ReturnType<typeof item>; ratings: RatedFrom[] }[] = [];
  const add = (ratings: RatedFrom[], inSeries = false) => {
    const n = cases.length;
    cases.push({
      item: item({
        id: `rating-case-${n}`,
        title: `Invented Rating Case ${n}`,
        firstPublishYear: 1980,
        acquired: { date: '2020-01-01', basis: 'entered' },
        series: inSeries ? series(`rating-series-${n}`, 1) : null,
      }),
      ratings: ratings.map((r) => ({ ...r, sourceId: `${r.sourceId}-${n}` })),
    });
  };
  add([rating({ count: 3 }), rating({ source: 'openlibrary', count: 3000 })]);
  add([rating({ count: 25, match: 'confirmed' }), rating({ source: 'openlibrary', count: 5000 })]);
  add([
    rating({ count: 1000, match: 'confirmed' }),
    rating({ source: 'openlibrary', count: 50000 }),
  ]);
  add(
    [
      rating({ scope: 'series', count: 10000 }),
      rating({ source: 'openlibrary', scope: 'volume', count: 20 }),
    ],
    true,
  );
  add(
    [
      rating({ scope: 'volume', count: 3 }),
      rating({ source: 'anilist', value: 90, scale: 100, scope: 'series', count: 10000 }),
    ],
    true,
  );
  add([rating({ count: 8 }), rating({ source: 'openlibrary', count: 3000 })]);
  add([rating({ count: 8 }), rating({ source: 'openlibrary', count: 8 })]);
  add([
    rating({ count: 8, match: 'provisional' }),
    rating({ source: 'openlibrary', count: 0, value: 1 }),
  ]);
  add([rating({ count: 8, match: 'provisional' })]);
  add([rating({ count: null })]);
  add([rating({ count: 0 })]);
  add([]);
  add([rating({ count: 1_000_000, match: 'tie' }), rating({ source: 'openlibrary', count: 30 })]);
  add([rating({ count: 1_000_000, match: 'rejected' })]);
  add([rating({ count: 1_000_000, match: 'unidentified', matchScore: 0.3 })]);
  for (let n = 0; n < 12; n++) {
    add(
      [rating({ source: 'anilist', scope: 'series', count: 10000, value: 90, scale: 100 })],
      true,
    );
    cases.at(-1)!.ratings[0]!.sourceId = 'invented-shared-series';
    cases.at(-1)!.item.series = series('invented-shared-series', n + 1);
  }
  // A source-relative distribution: fixtures must exercise shrinkage and each site's percentile.
  for (let n = 0; n < 32; n++)
    add([
      rating({ count: 100 + n * 100, value: 2 + n / 15 }),
      rating({ source: 'openlibrary', count: 100 + n * 200, value: 2 + n / 15 }),
    ]);
  return cases;
}
