/**
 * One adapter interface for every online source (PLAN.md §12.1): caching, polite per-source
 * rate limits, a circuit breaker, and a recorded source for each field used.
 *
 * Everything a source says is untrusted text. It is stored and shown as text, never as HTML.
 */

export type SourceName =
  'openlibrary' | 'anilist' | 'hardcover' | 'metron' | 'comicvine' | 'calibre' | 'demo';

export const SOURCE_LABELS: Record<SourceName, string> = {
  openlibrary: 'Open Library',
  anilist: 'AniList',
  hardcover: 'Hardcover',
  metron: 'Metron',
  comicvine: 'ComicVine',
  // The owner's own Calibre library (§14): curated metadata, read from a copy of metadata.db.
  calibre: 'Calibre',
  demo: 'Demo source (invented)',
};

/** What we ask a source: built from the item's facts. */
export interface SourceQuery {
  title: string;
  /** Raw run-together title from the filename, when the split guess may be wrong. */
  rawTitle?: string;
  author?: string;
  isbn?: string;
  /** Manga or comics: the series name and a volume number. */
  series?: string;
  volume?: string;
  /** A single comic issue's number ("12", "1.5", "Annual 1"). */
  issue?: string;
}

/** A rating as the source states it, with what it rates (§12.2). */
export interface SourceRating {
  /** Raw average on the source's scale. */
  value: number;
  /** Largest possible value: 5 for star ratings, 100 for AniList. */
  scale: number;
  /** Number of votes; null when the source doesn't say. */
  count: number | null;
  /** What the score is for. A series score is never shown as a volume's (§12.2). */
  scope: 'book' | 'volume' | 'series';
}

/** One candidate from a source, normalised. Unknown stays undefined — never invented. */
export interface SourceRecord {
  source: SourceName;
  sourceId: string;
  title: string;
  subtitle?: string;
  /** Other names for the same work (AniList's romaji/English titles, Hardcover's alternatives). */
  alternativeTitles?: string[];
  authors: string[];
  /** Public cover for visual comparison; never used to accept a match automatically. */
  coverUrl?: string;
  publisher?: string;
  firstPublishYear?: number;
  /**
   * Years a comic issue is known by: its cover year and its series' start year. A file's year
   * ("(2019)" in the name, ComicInfo's Year) agreeing with one is evidence (§11.2).
   */
  years?: number[];
  isbns: string[];
  /** Subjects, genres and tags, as the source names them. */
  subjects: string[];
  /** Page count of a typical edition. Always a rough length basis (§12.3). */
  pages?: number;
  rating?: SourceRating;
  series?: {
    name: string;
    /** The source's own id for the series or run (Metron series, ComicVine volume). */
    id?: string;
    /** Explicit start of this run, never an issue's cover/publication year. */
    startYear?: number;
    position?: number;
    /** Installments the source says exist (finished series), when it states it. */
    total?: number;
    status?: 'finished' | 'ongoing' | 'unknown';
  };
  /**
   * For a collected edition: the issues it reprints, as the source names them (§12.5). Only a
   * suggestion until the owner confirms it.
   */
  collects?: { series: string; year?: number; number: string }[];
  /** Source's own format hint, e.g. AniList MANGA / NOVEL / ONE_SHOT, Hardcover's category. */
  format?: string;
  /** e.g. 'JP' for manga, from AniList. */
  country?: string;
  description?: string;
  /** Public page for this record, shown as a link (text, never raw HTML). */
  url?: string;
}

/** Explicit primary volumes with a release date; never inferred from an aggregate count. */
export interface PublishedVolume {
  position: number;
  title: string;
  sourceId: string;
  publishedOn: string;
}
export interface PublishedSeries {
  source: 'hardcover' | 'demo';
  sourceSeriesId: string;
  name: string;
  entries: PublishedVolume[];
}

/** A fetch function the adapters use; tests pass a fake that replays recorded responses. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class SourceError extends Error {
  readonly source: SourceName;
  /** True for problems worth retrying later (timeouts, 429, 5xx). */
  readonly transient: boolean;
  /** The source's daily allowance is used up: not this book's fault, try again tomorrow. */
  readonly quota: boolean;
  constructor(source: SourceName, message: string, transient: boolean, quota = false) {
    super(message);
    this.source = source;
    this.transient = transient;
    this.quota = quota;
  }
}

export interface SourceAdapter {
  readonly name: SourceName;
  /**
   * Asked only when the other sources for the item found nothing usable (ComicVine, whose
   * hourly allowance is small). Otherwise its lookup is recorded as skipped.
   */
  readonly fallback?: boolean;
  /** Search by title/author (and ISBN where the source supports it). */
  search(q: SourceQuery, opts?: { refresh?: boolean }): Promise<SourceRecord[]>;
}
