import type { RatedFrom } from '../lib/ratings.ts';

/** Invented rating evidence; no real books, source calls or identifiers. */
export const rating = (over: Partial<RatedFrom> = {}): RatedFrom => ({
  source: 'hardcover',
  sourceId: 'invented-record',
  value: 4.5,
  scale: 5,
  count: 25,
  scope: 'book',
  match: 'accepted',
  strongIsbn: false,
  matchScore: 0.95,
  url: null,
  ...over,
});
