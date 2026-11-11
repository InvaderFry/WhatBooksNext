import {
  ANILIST_MIN_INTERVAL_MS,
  COMICVINE_MIN_INTERVAL_MS,
  HARDCOVER_DAILY_LIMIT,
  HARDCOVER_MIN_INTERVAL_MS,
  METRON_DAILY_LIMIT,
  METRON_MIN_INTERVAL_MS,
  OPENLIBRARY_MIN_INTERVAL_MS,
  REFRESH_ACTIVE_DAYS,
  REFRESH_JITTER,
  REFRESH_OPEN_DAYS,
  REFRESH_RETRY_DAYS,
  REFRESH_SETTLED_DAYS,
} from '../config.ts';
import type { SourceName } from '../sources/types.ts';

/**
 * When to ask a source again about a book (ratings plan stage 4). Pure: the scheduler in
 * identify/refresher.ts gathers the rows and runs the lookups.
 *
 * - Books in progress or shortlisted: every REFRESH_ACTIVE_DAYS, from every source.
 * - A source that rates this kind of book, while the book has no supported rating from a
 *   trusted match anywhere: every REFRESH_OPEN_DAYS (new ratings arrive as people read it).
 * - Everything else (settled ratings, Metron and ComicVine, which never rate, books marked Never
 *   or only read elsewhere): every REFRESH_SETTLED_DAYS.
 * - A failed lookup is retried after 1, 3 and 7 days, then returns to its group.
 */

const DAY_MS = 86_400_000;

export type RefreshGroup = 'active' | 'open' | 'settled';

export const GROUP_DAYS: Record<RefreshGroup, number> = {
  active: REFRESH_ACTIVE_DAYS,
  open: REFRESH_OPEN_DAYS,
  settled: REFRESH_SETTLED_DAYS,
};

/** Sources that give ratings. Metron and ComicVine never do. */
export const RATING_SOURCES: SourceName[] = ['hardcover', 'openlibrary', 'anilist'];

/** A daily allowance: automatic work uses at most a share of it. */
export const DAILY_LIMITS: Partial<Record<SourceName, number>> = {
  hardcover: HARDCOVER_DAILY_LIMIT,
  metron: METRON_DAILY_LIMIT,
};

/**
 * Rough requests one lookup makes per source (a search, then a record or series where the
 * adapter fetches one). Used to stop a batch before it overshoots and for the estimate shown
 * before "Look up all books again"; the budget itself counts the real requests.
 */
export const REQUESTS_PER_LOOKUP: Record<SourceName, number> = {
  openlibrary: 1,
  anilist: 1,
  hardcover: 2,
  metron: 2,
  comicvine: 2,
  calibre: 0,
  demo: 0,
};

const MIN_INTERVAL: Record<SourceName, number> = {
  openlibrary: OPENLIBRARY_MIN_INTERVAL_MS,
  anilist: ANILIST_MIN_INTERVAL_MS,
  hardcover: HARDCOVER_MIN_INTERVAL_MS,
  metron: METRON_MIN_INTERVAL_MS,
  comicvine: COMICVINE_MIN_INTERVAL_MS,
  calibre: 0,
  demo: 0,
};

export interface RefreshRow {
  itemId: string;
  source: SourceName;
  outcome: string;
  lookedUpAt: string;
  lastAnswerAt: string | null;
  nextEligibleAt: string | null;
  failureCount: number;
  /** In progress or shortlisted. */
  active: boolean;
  /** Marked Never, hidden, or only read elsewhere: little reason to ask often. */
  quiet: boolean;
  /** The book has a rating from a trusted match with enough votes, on any source. */
  wellRated: boolean;
}

/** A fixed number in [0, 1) for a key (FNV-1a), so jitter is the same on every check. */
export function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

function stretch(days: number, key: string): number {
  return Math.round(days * DAY_MS * (1 + REFRESH_JITTER * hash01(key)));
}

/** When a source that failed `failures` times in a row is tried again; null after the third. */
export function retryAt(
  itemId: string,
  source: string,
  failures: number,
  lookedUpAt: string,
): string | null {
  const days = REFRESH_RETRY_DAYS[failures - 1];
  if (days === undefined) return null;
  return new Date(
    Date.parse(lookedUpAt) + stretch(days, `${itemId}:${source}:${failures}`),
  ).toISOString();
}

export function refreshGroup(r: Pick<RefreshRow, 'source' | 'active' | 'quiet' | 'wellRated'>) {
  if (r.active) return 'active' as const;
  if (r.quiet) return 'settled' as const;
  if (RATING_SOURCES.includes(r.source) && !r.wellRated) return 'open' as const;
  return 'settled' as const;
}

/**
 * When this source is next due for this book, in ms; null when it is never asked on its own (a
 * ComicVine lookup skipped because Metron found the issue follows Metron's schedule).
 */
export function dueAt(r: RefreshRow): number | null {
  if (r.outcome === 'skipped') return null;
  const days = GROUP_DAYS[refreshGroup(r)];
  let due: number;
  if (r.failureCount > 0) {
    const retry = REFRESH_RETRY_DAYS[r.failureCount - 1] ?? days;
    due = Date.parse(r.lookedUpAt) + stretch(retry, `${r.itemId}:${r.source}:${r.failureCount}`);
  } else if (r.lastAnswerAt === null) {
    // Never answered (a first lookup that hit a used-up allowance): due as soon as allowed.
    due = Date.parse(r.lookedUpAt);
  } else {
    due = Date.parse(r.lastAnswerAt) + stretch(days, `${r.itemId}:${r.source}`);
  }
  const notBefore = r.nextEligibleAt ? Date.parse(r.nextEligibleAt) : NaN;
  if (Number.isFinite(notBefore) && notBefore > due) due = notBefore;
  return Number.isFinite(due) ? due : null;
}

export interface DueItem {
  itemId: string;
  /** The sources due for this book. */
  sources: SourceName[];
  active: boolean;
  /** How long the most overdue of them is overdue, in ms. */
  overdueMs: number;
}

/** Books with at least one due source: in-progress and shortlisted first, then most overdue. */
export function dueItems(rows: RefreshRow[], now: number): DueItem[] {
  const by = new Map<string, DueItem>();
  for (const r of rows) {
    const at = dueAt(r);
    if (at === null || at > now) continue;
    const d = by.get(r.itemId) ?? {
      itemId: r.itemId,
      sources: [],
      active: r.active,
      overdueMs: 0,
    };
    d.sources.push(r.source);
    d.overdueMs = Math.max(d.overdueMs, now - at);
    by.set(r.itemId, d);
  }
  return [...by.values()].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.overdueMs - a.overdueMs ||
      a.itemId.localeCompare(b.itemId),
  );
}

/**
 * A rough figure for "Look up all books again": requests per source, the hours the polite
 * spacing takes (each book waits for its slowest source), and days, because Hardcover and Metron
 * allow 5,000 requests a day.
 */
export function freshEstimate(itemSources: SourceName[][]): {
  books: number;
  requests: number;
  hours: number;
  days: number;
} {
  let requests = 0;
  let ms = 0;
  const per = new Map<SourceName, number>();
  for (const srcs of itemSources) {
    let slowest = 0;
    for (const s of srcs) {
      // ComicVine is asked only when Metron finds nothing: not counted up front.
      if (s === 'comicvine' && srcs.includes('metron')) continue;
      const n = REQUESTS_PER_LOOKUP[s];
      requests += n;
      per.set(s, (per.get(s) ?? 0) + n);
      slowest = Math.max(slowest, n * MIN_INTERVAL[s]);
    }
    ms += slowest;
  }
  let days = itemSources.length > 0 ? 1 : 0;
  for (const [s, n] of per) {
    const limit = DAILY_LIMITS[s];
    if (limit) days = Math.max(days, Math.ceil(n / (limit - 200)));
  }
  return {
    books: itemSources.length,
    requests,
    hours: Math.round((ms / 3_600_000) * 10) / 10,
    days,
  };
}
