import { similarity } from '../identify/match.ts';
import { titleCompareKey } from '../identify/filename.ts';
import type { SourceAdapter, SourceQuery, SourceRecord } from './types.ts';

/**
 * The demo's only source (DEMO=1, PLAN.md §17). Every work, author and number here is
 * invented for the invented demo library and labelled "Demo source (invented)" wherever it
 * shows. No network, no keys, and nothing about real works.
 */

const rec = (
  r: Omit<SourceRecord, 'source' | 'isbns' | 'subjects'> & Partial<SourceRecord>,
): SourceRecord => ({
  source: 'demo',
  isbns: [],
  subjects: [],
  ...r,
});

export const DEMO_RECORDS: SourceRecord[] = [
  rec({
    sourceId: 'demo-1',
    title: 'Glass Harbor',
    authors: ['Mira Vantongeren'],
    firstPublishYear: 1994,
    subjects: ['Fiction', 'Sea stories'],
    pages: 340,
    rating: { value: 4.4, scale: 5, count: 2900, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-2',
    title: 'The Mapmaker’s Daughter',
    authors: ['Hollis Quarrender'],
    firstPublishYear: 2011,
    subjects: ['Fiction', 'Historical fiction'],
    rating: { value: 4.1, scale: 5, count: 830, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-3',
    title: 'The Lantern Keepers',
    authors: ['Odile Brannagh'],
    firstPublishYear: 1979,
    subjects: ['Fiction', 'Fantasy'],
    rating: { value: 4.3, scale: 5, count: 5400, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-4',
    title: 'River of Clocks',
    authors: ['Tamsin Achterberg'],
    firstPublishYear: 2019,
    subjects: ['Fantasy'],
    series: { name: 'The Clockwater Books', position: 1, total: 3, status: 'finished' },
    rating: { value: 3.9, scale: 5, count: 410, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-5',
    title: 'Salt and Ember',
    authors: ['Inés Corvalán'],
    firstPublishYear: 2008,
    subjects: ['Fiction', 'Translations'],
    rating: { value: 4.6, scale: 5, count: 38, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-6',
    title: 'Quiet Mornings',
    subtitle: 'A Handbook for Slow Starts',
    authors: ['Bertil Haaland'],
    firstPublishYear: 2016,
    subjects: ['Self-help', 'Habits'],
    rating: { value: 3.7, scale: 5, count: 1200, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-7',
    title: 'Practical Widget Crafting',
    authors: ['Lio Sandoval'],
    firstPublishYear: 2003,
    subjects: ['Computer programming', 'Software'],
    rating: { value: 4.0, scale: 5, count: 260, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-8',
    title: 'Widget Patterns',
    authors: ['Ada Quill'],
    firstPublishYear: 1996,
    subjects: ['Computer programming', 'Software design'],
    pages: 290,
    rating: { value: 4.5, scale: 5, count: 3100, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-9',
    title: 'Night Orchard',
    authors: ['Petra Lindqvist-Arno'],
    firstPublishYear: 2021,
    subjects: ['Fiction', 'Mystery'],
    rating: { value: 4.2, scale: 5, count: 95, scope: 'book' },
  }),
  rec({
    sourceId: 'demo-10',
    title: 'Salt Road Songs',
    authors: ['Anouk Teversham'],
    firstPublishYear: 1988,
    subjects: ['Fiction'],
    rating: { value: 4.0, scale: 5, count: 640, scope: 'book' },
  }),
  // Two different works with nearly the same title: a tie the owner settles (§11.2).
  rec({
    sourceId: 'demo-11',
    title: 'A Field Guide to Puddles',
    authors: ['Wendell Okafor'],
    firstPublishYear: 2002,
    subjects: ['Nature', 'Science'],
  }),
  rec({
    sourceId: 'demo-12',
    title: 'Field Guide to Puddles',
    authors: ['Greta Sommerfeld'],
    firstPublishYear: 2014,
    subjects: ['Children’s books'],
  }),
  rec({
    sourceId: 'demo-13',
    title: 'Starfall Academy',
    authors: ['Kaede Morishita'],
    firstPublishYear: 2015,
    subjects: ['Comedy', 'School'],
    format: 'MANGA',
    country: 'JP',
    series: { name: 'Starfall Academy', status: 'ongoing' },
    rating: { value: 84, scale: 100, count: 15000, scope: 'series' },
  }),
];

export class DemoSource implements SourceAdapter {
  readonly name = 'demo' as const;
  async search(q: SourceQuery): Promise<SourceRecord[]> {
    // Like the real sources: books by title, manga by series name.
    const keys = [q.title, q.series]
      .filter((t): t is string => !!t)
      .map((t) => titleCompareKey(t.split(':')[0]!));
    return DEMO_RECORDS.filter((r) => {
      const k = titleCompareKey(r.title);
      return keys.some((key) => k === key || similarity(k, key) >= 0.6);
    });
  }
}
