import { decodeEntities } from '../util.ts';
import { OPENLIBRARY_MIN_INTERVAL_MS, SEARCH_RESULTS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { SourceClient } from './client.ts';
import type { Fetcher, SourceAdapter, SourceQuery, SourceRecord } from './types.ts';

/**
 * Open Library (§12.1): keyless book search. Rules verified November 2026 at
 * openlibrary.org/developers/api: identify the app in the User-Agent, about 1 request a second
 * without a contact email, cache, use search.json rather than many single-book requests, and
 * no bulk downloading. Covers come from the files themselves, so the rate-limited covers API
 * isn't used.
 */

const FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'isbn',
  'subject',
  'number_of_pages_median',
  'ratings_average',
  'ratings_count',
  'edition_count',
  'language',
  'series_name',
].join(',');

interface OlDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  subject?: string[];
  number_of_pages_median?: number;
  ratings_average?: number;
  ratings_count?: number;
  series_name?: string[];
}

export function openLibraryUrl(q: SourceQuery): { url: string; key: string } {
  const p = new URLSearchParams();
  if (q.isbn) p.set('isbn', q.isbn);
  else {
    p.set('title', q.title);
    if (q.author) p.set('author', q.author);
  }
  p.set('limit', String(SEARCH_RESULTS));
  p.set('fields', FIELDS);
  const key = q.isbn
    ? `isbn:${q.isbn}`
    : `search:title=${q.title.toLowerCase()}|author=${(q.author ?? '').toLowerCase()}`;
  return { url: `https://openlibrary.org/search.json?${p.toString()}`, key };
}

export function parseOpenLibrary(payload: unknown): SourceRecord[] {
  const docs = (payload as { docs?: OlDoc[] } | null)?.docs;
  if (!Array.isArray(docs)) return [];
  const out: SourceRecord[] = [];
  for (const d of docs) {
    if (!d.key || !d.title) continue;
    const r: SourceRecord = {
      source: 'openlibrary',
      sourceId: d.key,
      title: decodeEntities(d.title),
      authors: (d.author_name ?? []).map(decodeEntities),
      isbns: (d.isbn ?? []).slice(0, 20),
      subjects: (d.subject ?? []).slice(0, 30),
      url: `https://openlibrary.org${d.key}`,
    };
    if (d.subtitle) r.subtitle = decodeEntities(d.subtitle);
    if (typeof d.first_publish_year === 'number') r.firstPublishYear = d.first_publish_year;
    if (typeof d.number_of_pages_median === 'number' && d.number_of_pages_median > 0)
      r.pages = d.number_of_pages_median;
    // Open Library's star ratings are for the work (every edition together), out of 5.
    if (
      typeof d.ratings_average === 'number' &&
      typeof d.ratings_count === 'number' &&
      d.ratings_count > 0
    )
      r.rating = { value: d.ratings_average, scale: 5, count: d.ratings_count, scope: 'book' };
    if (d.series_name?.[0]) r.series = { name: d.series_name[0] };
    out.push(r);
  }
  return out;
}

export class OpenLibrary implements SourceAdapter {
  readonly name = 'openlibrary' as const;
  readonly client: SourceClient;
  constructor(db: DB | null, fetcher?: Fetcher) {
    this.client = new SourceClient({
      name: 'openlibrary',
      minIntervalMs: OPENLIBRARY_MIN_INTERVAL_MS,
      db,
      fetcher,
    });
  }

  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const { url, key } = openLibraryUrl(q);
    return parseOpenLibrary(await this.client.json(url, {}, key, opts));
  }
}
