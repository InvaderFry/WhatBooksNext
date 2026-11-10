import {
  HARDCOVER_DAILY_LIMIT,
  HARDCOVER_MIN_INTERVAL_MS,
  SEARCH_RESULTS,
  SERIES_PUBLICATION_LIMIT,
  SERIES_MEMBERSHIP_LIMIT,
} from '../config.ts';
import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { decodeEntities, todayLocal } from '../util.ts';
import { SourceClient } from './client.ts';
import { DailyUsage } from './usage.ts';
import {
  SourceError,
  type Fetcher,
  type SourceAdapter,
  type SourceQuery,
  type SourceRecord,
  type PublishedSeries,
  type PublishedVolume,
} from './types.ts';

/**
 * Hardcover (§12.1): book ratings and counts, series, genres. Needs the owner's free token.
 *
 * Checked in November 2026 against Hardcover's own docs (github.com/hardcoverapp/hardcover-docs,
 * because docs.hardcover.app refuses automated reads):
 *  - GraphQL at https://api.hardcover.app/v1/graphql, token in the `authorization` header;
 *  - a token needs only the read-only `read:catalog` scope for search;
 *  - free tokens: 60 requests a minute, a burst of 10, 5,000 a day; each top-level field
 *    counts as one request; search times out after 2 s;
 *  - personal use is what free tokens are for; tokens must be kept out of the browser (ours
 *    stays on the server and out of backups, §6.3); a User-Agent describing the tool is
 *    recommended; aggregate data (average rating, number of readers) may be shown if named
 *    as Hardcover's.
 *
 * The response shape below follows the docs' list of search fields. It hasn't been seen with a
 * real token yet: the owner's Diagnostics → Test Hardcover run confirms it (M3 notes).
 */

export const HARDCOVER_URL = 'https://api.hardcover.app/v1/graphql';

/** Where the owner makes a token with just the scope we need. */
export const HARDCOVER_NEW_TOKEN_URL =
  'https://hardcover.app/account/api/keys/new?scope=read:catalog';

const SEARCH = `query Search($q: String!, $n: Int!) {
  search(query: $q, query_type: "Book", per_page: $n, page: 1) { results }
}`;

// Hardcover's GettingBooksInSeries guide: exclude compilations, partial and merged books,
// and pick the most popular work at each position. Release dates exclude announcements.
const SERIES_MEMBERSHIP = `query SeriesMembership($book: Int!, $limit: Int!) {
  book_series(where: {book_id: {_eq: $book}, series: {canonical_id: {_is_null: true}}}, limit: $limit) {
    position featured compilation series { id name }
  }
}`;
const SERIES_PUBLICATIONS = `query PublishedSeries($id: Int!, $today: date!, $limit: Int!) {
  series_by_pk(id: $id) {
    id name
    book_series(
      distinct_on: position
      order_by: [{position: asc}, {book: {users_count: desc}}]
      where: {compilation: {_eq: false}, position: {_gte: 1},
        book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}, release_date: {_lte: $today}}}
      limit: $limit
    ) {
      position compilation
      book { id title release_date canonical_id is_partial_book }
    }
  }
}`;

export function parsePublishedSeries(
  payload: unknown,
  expectedId: string,
  expectedName: string,
  today = todayLocal(),
): PublishedSeries {
  const series = (
    payload as { data?: { series_by_pk?: { id?: unknown; name?: unknown; book_series?: unknown } } }
  )?.data?.series_by_pk;
  if (
    !series ||
    String(series.id) !== expectedId ||
    typeof series.name !== 'string' ||
    titleCompareKey(series.name) !== titleCompareKey(expectedName) ||
    !Array.isArray(series.book_series)
  )
    throw new SourceError('hardcover', 'Couldn’t verify this series catalogue.', false);
  if (series.book_series.length > SERIES_PUBLICATION_LIMIT)
    throw new SourceError(
      'hardcover',
      'This series catalogue is too large to verify in one request.',
      false,
    );
  const entries = new Map<number, PublishedVolume>();
  for (const raw of series.book_series) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as {
      position?: unknown;
      compilation?: unknown;
      book?: {
        id?: unknown;
        title?: unknown;
        release_date?: unknown;
        canonical_id?: unknown;
        is_partial_book?: unknown;
      };
    };
    const b = row.book;
    if (
      !Number.isInteger(row.position) ||
      (row.position as number) < 1 ||
      row.compilation !== false ||
      !b ||
      b.canonical_id !== null ||
      b.is_partial_book !== false ||
      typeof b.title !== 'string' ||
      !b.title.trim() ||
      !/^\d+$/.test(String(b.id)) ||
      typeof b.release_date !== 'string'
    )
      continue;
    const date = b.release_date;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date > today
    )
      continue;
    const position = row.position as number;
    if (!entries.has(position))
      entries.set(position, {
        position,
        title: b.title,
        sourceId: String(b.id),
        publishedOn: date,
      });
  }
  return {
    source: 'hardcover',
    sourceSeriesId: expectedId,
    name: series.name,
    entries: [...entries.values()].sort((a, b) => a.position - b.position),
  };
}

interface HcDocument {
  id?: number | string;
  title?: string;
  subtitle?: string;
  alternative_titles?: string[];
  author_names?: string[];
  rating?: number | null;
  ratings_count?: number | null;
  release_year?: number | null;
  pages?: number | null;
  isbns?: string[];
  series_names?: string[];
  featured_series?: {
    position?: number | null;
    series?: {
      name?: string;
      books_count?: number;
      primary_books_count?: number;
      is_completed?: boolean;
    };
  } | null;
  featured_series_position?: number | null;
  genres?: string[];
  tags?: string[];
  moods?: string[];
  description?: string | null;
  slug?: string;
}

/** Token as pasted: with or without "Bearer ", spaces trimmed. */
export function normaliseToken(raw: string): string {
  return raw
    .trim()
    .replace(/^bearer\s+/i, '')
    .trim();
}

export function parseHardcover(payload: unknown): SourceRecord[] {
  const results = (payload as { data?: { search?: { results?: unknown } } } | null)?.data?.search
    ?.results;
  // `results` is Typesense's answer: { hits: [{ document }] }. Sometimes sent as a JSON string.
  const r = typeof results === 'string' ? safeJson(results) : results;
  const hits = (r as { hits?: { document?: HcDocument }[] } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: SourceRecord[] = [];
  for (const h of hits) {
    const d = h?.document;
    if (!d || d.id === undefined || !d.title) continue;
    const rec: SourceRecord = {
      source: 'hardcover',
      sourceId: String(d.id),
      title: decodeEntities(d.title),
      authors: (d.author_names ?? []).map(decodeEntities),
      isbns: (d.isbns ?? []).slice(0, 20),
      subjects: [...(d.genres ?? []), ...(d.tags ?? [])],
      url: d.slug ? `https://hardcover.app/books/${encodeURIComponent(d.slug)}` : undefined,
    };
    // Hardcover's titles sometimes already include the subtitle; don't show it twice.
    if (d.subtitle && !d.title.toLowerCase().includes(d.subtitle.toLowerCase()))
      rec.subtitle = d.subtitle;
    if (d.alternative_titles?.length) rec.alternativeTitles = d.alternative_titles;
    if (typeof d.release_year === 'number' && d.release_year > 0)
      rec.firstPublishYear = d.release_year;
    if (typeof d.pages === 'number' && d.pages > 0) rec.pages = d.pages;
    // Hardcover's average is out of 5 and covers the book (every edition).
    if (typeof d.rating === 'number' && typeof d.ratings_count === 'number' && d.ratings_count > 0)
      rec.rating = { value: d.rating, scale: 5, count: d.ratings_count, scope: 'book' };
    const fs = d.featured_series;
    const seriesName = fs?.series?.name ?? d.series_names?.[0];
    if (seriesName) {
      const pos = fs?.position ?? d.featured_series_position;
      const total = fs?.series?.primary_books_count ?? fs?.series?.books_count;
      rec.series = {
        name: seriesName,
        ...(typeof pos === 'number' ? { position: pos } : {}),
        ...(fs?.series?.is_completed && typeof total === 'number' ? { total } : {}),
        // "Not marked completed" isn't the same as ongoing, so only "finished" is trusted.
        status: fs?.series?.is_completed === true ? 'finished' : 'unknown',
      };
    }
    if (d.description) rec.description = d.description;
    out.push(rec);
  }
  return out;
}

function graphqlError(payload: unknown): string | null {
  const errors = (payload as { errors?: { message?: string }[] } | null)?.errors;
  return Array.isArray(errors) && errors.length > 0 ? (errors[0]?.message ?? 'error') : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

export class Hardcover implements SourceAdapter {
  readonly name = 'hardcover' as const;
  readonly client: SourceClient;
  private readonly getToken: () => string | null;

  constructor(db: DB | null, getToken: () => string | null, fetcher?: Fetcher) {
    this.getToken = getToken;
    this.usage = new DailyUsage(db, 'hardcoverUsage');
    this.client = new SourceClient({
      name: 'hardcover',
      minIntervalMs: HARDCOVER_MIN_INTERVAL_MS,
      db,
      fetcher,
    });
  }

  configured(): boolean {
    return !!this.getToken();
  }

  /** Requests made today, against the free daily allowance (kept across restarts). */
  private readonly usage: DailyUsage;

  private async query(
    query: string,
    variables: Record<string, unknown>,
    key: string,
    refresh = false,
  ): Promise<unknown> {
    const token = this.getToken();
    if (!token) throw new SourceError('hardcover', 'No Hardcover token in Settings.', false);
    if (!refresh) {
      const hit = this.client.cached(key);
      if (hit !== undefined && !graphqlError(hit)) return hit;
    }
    if (this.usageToday() >= HARDCOVER_DAILY_LIMIT - 200)
      throw new SourceError(
        'hardcover',
        'Reached today’s Hardcover allowance; carrying on tomorrow.',
        true,
      );
    this.usage.count();
    const payload = await this.client.json(
      HARDCOVER_URL,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${normaliseToken(token)}` },
        body: { query, variables },
      },
      null,
      { refresh: true },
    );
    const err = graphqlError(payload);
    if (err) throw new SourceError('hardcover', `Hardcover said: ${err}`, false);
    this.client.store(key, payload);
    return payload;
  }

  async publishedSeries(
    bookId: string,
    name: string,
    position: number | null,
    opts: { refresh?: boolean; today?: string } = {},
  ): Promise<PublishedSeries> {
    const id = Number(bookId);
    if (!/^\d+$/.test(bookId) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
      throw new SourceError('hardcover', 'This book has no usable Hardcover id.', false);
    const memberships = await this.query(
      SERIES_MEMBERSHIP,
      { book: id, limit: SERIES_MEMBERSHIP_LIMIT },
      `series-membership:v2:${id}`,
      opts.refresh,
    );
    const rows = (
      memberships as {
        data?: {
          book_series?: {
            position?: number;
            featured?: boolean;
            compilation?: boolean;
            series?: { id: number; name: string };
          }[];
        };
      }
    )?.data?.book_series;
    if (!Array.isArray(rows) || rows.length >= SERIES_MEMBERSHIP_LIMIT)
      throw new SourceError(
        'hardcover',
        'Couldn’t verify which series this book belongs to.',
        false,
      );
    const matching = rows.filter(
      (r) =>
        r?.series &&
        r.compilation === false &&
        Number.isInteger(r.series.id) &&
        r.series.id > 0 &&
        typeof r.series.name === 'string' &&
        titleCompareKey(r.series.name) === titleCompareKey(name) &&
        (position === null || r.position === position),
    );
    const candidates = [...new Map(matching.map((r) => [r.series!.id, r])).values()];
    const featured = candidates.filter((r) => r.featured === true);
    let chosen =
      candidates.length === 1 ? candidates[0] : featured.length === 1 ? featured[0] : undefined;
    if (!chosen && candidates.length === 0 && position !== null) {
      // The names differ (a file's "march" against Hardcover's "March Trilogy", say), but the
      // matched book is in exactly one real series, at the same number: that's the one. Two
      // checks still agree — the confirmed book and its number — and a compilation never counts.
      const atPosition = [
        ...new Map(
          rows
            .filter(
              (r) =>
                r?.series &&
                r.compilation === false &&
                Number.isInteger(r.series.id) &&
                r.series.id > 0 &&
                r.position === position,
            )
            .map((r) => [r.series!.id, r]),
        ).values(),
      ];
      const real = new Set(
        rows.filter((r) => r?.series && r.compilation === false).map((r) => r.series!.id),
      );
      if (atPosition.length === 1 && real.size === 1) chosen = atPosition[0];
    }
    if (!chosen?.series)
      throw new SourceError(
        'hardcover',
        'Couldn’t confidently identify this series. Check the book’s online match and series number.',
        false,
      );
    const payload = await this.query(
      SERIES_PUBLICATIONS,
      {
        id: chosen.series.id,
        today: opts.today ?? todayLocal(),
        limit: SERIES_PUBLICATION_LIMIT + 1,
      },
      `series-publications:v1:${chosen.series.id}`,
      opts.refresh,
    );
    // Checked against the series the membership named (the same as the file's name, unless the
    // fallback above chose it by the book and its number).
    return parsePublishedSeries(payload, String(chosen.series.id), chosen.series.name, opts.today);
  }

  usageToday(): number {
    return this.usage.today();
  }

  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const token = this.getToken();
    if (!token) throw new SourceError('hardcover', 'No Hardcover token in Settings.', false);
    const text = [q.title, q.author].filter(Boolean).join(' ');
    const key = `search:${text.toLowerCase()}`;
    // A cached answer costs nothing against the allowance.
    if (!opts.refresh) {
      const hit = this.client.cached(key);
      if (hit !== undefined && !graphqlError(hit)) return parseHardcover(hit);
    }
    // Stop a little short of the daily allowance, so the owner's own use of Hardcover isn't
    // locked out for the rest of the day.
    if (this.usageToday() >= HARDCOVER_DAILY_LIMIT - 200)
      throw new SourceError(
        'hardcover',
        'Reached today’s Hardcover allowance; carrying on tomorrow.',
        true,
      );
    this.usage.count();
    const payload = await this.client.json(
      HARDCOVER_URL,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${normaliseToken(token)}` },
        body: { query: SEARCH, variables: { q: text, n: SEARCH_RESULTS } },
      },
      key,
      { refresh: true },
    );
    const err = graphqlError(payload);
    if (err) throw new SourceError('hardcover', `Hardcover said: ${err}`, false);
    return parseHardcover(payload);
  }
}
