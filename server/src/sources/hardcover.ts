import { HARDCOVER_DAILY_LIMIT, HARDCOVER_MIN_INTERVAL_MS, SEARCH_RESULTS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { todayLocal } from '../util.ts';
import { SourceClient } from './client.ts';
import {
  SourceError,
  type Fetcher,
  type SourceAdapter,
  type SourceQuery,
  type SourceRecord,
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
      title: d.title,
      authors: d.author_names ?? [],
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
  private readonly db: DB | null;

  constructor(db: DB | null, getToken: () => string | null, fetcher?: Fetcher) {
    this.db = db;
    this.getToken = getToken;
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

  /**
   * Requests made today, against the free daily allowance. Kept in the database, so restarting
   * the app doesn't forget them (it did at first: the owner saw 402 drop back to 4). Without a
   * database (tests), it's kept in memory.
   */
  private memoryUsage = { day: '', count: 0 };

  usageToday(): number {
    const u = this.readUsage();
    return u.day === todayLocal() ? u.count : 0;
  }

  private readUsage(): { day: string; count: number } {
    if (!this.db) return this.memoryUsage;
    const v = this.db
      .prepare("SELECT value FROM settings WHERE key = 'hardcoverUsage'")
      .pluck()
      .get() as string | undefined;
    const u = v ? (JSON.parse(v) as { day?: unknown; count?: unknown }) : {};
    return {
      day: typeof u.day === 'string' ? u.day : '',
      count: typeof u.count === 'number' ? u.count : 0,
    };
  }

  private countRequest(): number {
    const today = todayLocal();
    const u = this.readUsage();
    const next = { day: today, count: u.day === today ? u.count + 1 : 1 };
    if (!this.db) this.memoryUsage = next;
    else
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('hardcoverUsage', ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(next), new Date().toISOString());
    return next.count;
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
    this.countRequest();
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
