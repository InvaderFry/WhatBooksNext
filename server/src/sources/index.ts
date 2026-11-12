import type { DB } from '../db/database.ts';
import { nowIso } from '../util.ts';
import { AniList } from './anilist.ts';
import { ComicVine } from './comicvine.ts';
import type { SourceStatus } from './client.ts';
import { DemoSource } from './demo.ts';
import { Hardcover } from './hardcover.ts';
import { Metron } from './metron.ts';
import { OpenLibrary } from './openlibrary.ts';
import { SOURCE_LABELS, type Fetcher, type SourceAdapter, type SourceName } from './types.ts';

/** The configured sources. Built once per app; Hardcover reads its token on each request. */
export class Sources {
  readonly demo: boolean;
  readonly openlibrary: OpenLibrary;
  readonly anilist: AniList;
  readonly hardcover: Hardcover;
  readonly metron: Metron;
  readonly comicvine: ComicVine;
  readonly demoSource = new DemoSource();

  constructor(db: DB, opts: { demo?: boolean; fetcher?: Fetcher } = {}) {
    this.demo = Boolean(opts.demo);
    this.openlibrary = new OpenLibrary(db, opts.fetcher);
    this.anilist = new AniList(db, opts.fetcher);
    this.hardcover = new Hardcover(db, () => getSecret(db, 'hardcover_token'), opts.fetcher);
    this.metron = new Metron(db, () => getSecret(db, 'metron_token'), opts.fetcher);
    this.comicvine = new ComicVine(db, () => getSecret(db, 'comicvine_key'), opts.fetcher);
  }

  /** The comic sources: Metron first, ComicVine as its fallback (only those set up, unless `all`). */
  private comics(all = false): SourceAdapter[] {
    return [
      ...(all || this.metron.configured() ? [this.metron] : []),
      ...(all || this.comicvine.configured() ? [this.comicvine] : []),
    ];
  }

  /**
   * Which sources to ask for an item (§12.1). Open Library and AniList are the keyless baseline;
   * Hardcover joins when the owner has a token.
   *  - Books: Open Library (+ Hardcover).
   *  - Manga: AniList for the series (score, status), and the book sources too, which list each
   *    volume as a book with its own rating (the owner's first run showed Hardcover does).
   *  - Comic volumes and collected editions: the book sources, which list them the same way.
   *  - Single issues ("Series #48") of anything but manga: Metron, then ComicVine only when
   *    Metron finds nothing (its allowance is small). Never the book sources: they only return
   *    unrelated novels with the series' name. With neither set up, issues aren't looked up.
   */
  forItem(kind: string | null, issue: string | null = null): SourceAdapter[] {
    return this.plan(kind, issue, false);
  }

  /**
   * The sources that cover this kind of item if every optional one were set up: the book page
   * tells "not set up" apart from "doesn't cover this kind of book".
   */
  coveringSources(kind: string | null, issue: string | null = null): SourceName[] {
    return this.plan(kind, issue, true).map((s) => s.name);
  }

  private plan(kind: string | null, issue: string | null, all: boolean): SourceAdapter[] {
    if (this.demo) return [this.demoSource];
    const books: SourceAdapter[] =
      all || this.hardcover.configured() ? [this.openlibrary, this.hardcover] : [this.openlibrary];
    if (kind === 'manga') return [this.anilist, ...books];
    if (issue) return this.comics(all);
    // A collected comic volume: the book sources rate it; Metron says what it reprints (§12.5).
    if (kind === 'comic' && (all || this.metron.configured())) return [...books, this.metron];
    return books;
  }

  /** Whether an optional source has its key or token. Keyless sources are always set up. */
  isConfigured(name: SourceName): boolean {
    if (name === 'hardcover') return this.hardcover.configured();
    if (name === 'metron') return this.metron.configured();
    if (name === 'comicvine') return this.comicvine.configured();
    return true;
  }

  /** Manual choices bypass the guessed kind; include unset sources to explain setup in the UI. */
  onlineSources(includeUnconfigured = false): SourceAdapter[] {
    if (this.demo) return [this.demoSource];
    return [this.openlibrary, this.hardcover, this.anilist, this.metron, this.comicvine].filter(
      (s) => includeUnconfigured || this.isConfigured(s.name),
    );
  }

  /** For "Search and pick" in Needs review: every source that can answer now. */
  forSearch(kind: string | null): SourceAdapter[] {
    if (this.demo) return [this.demoSource];
    const books: SourceAdapter[] = this.hardcover.configured()
      ? [this.hardcover, this.openlibrary]
      : [this.openlibrary];
    return kind === 'manga' || kind === 'comic'
      ? [...this.comics(), this.anilist, ...books]
      : [...books, this.anilist];
  }

  status(): (SourceStatus & { label: string; configured: boolean; note: string })[] {
    if (this.demo)
      return [
        {
          ...emptyStatus('demo'),
          label: SOURCE_LABELS.demo,
          configured: true,
          note: 'The demo uses invented data only and never goes online.',
        },
      ];
    return [
      {
        ...this.openlibrary.client.status(),
        label: SOURCE_LABELS.openlibrary,
        configured: true,
        note: 'No key needed. Books: search, subjects, first publication year, some ratings.',
      },
      {
        ...this.anilist.client.status(),
        label: SOURCE_LABELS.anilist,
        configured: true,
        note: 'No key needed. Manga: series scores, genres, publication status.',
      },
      {
        ...this.hardcover.client.status(),
        label: SOURCE_LABELS.hardcover,
        configured: this.hardcover.configured(),
        note: this.hardcover.configured()
          ? `Token saved. ${this.hardcover.usageToday()} of today’s 5,000 requests used by this app (Hardcover’s own count is on its API page).`
          : 'No token. Optional: adds book ratings with vote counts, series order and genres.',
      },
      {
        ...this.metron.client.status(),
        label: SOURCE_LABELS.metron,
        configured: this.metron.configured(),
        note: this.metron.configured()
          ? `Token saved. Single comic issues: series, number, cover year, whether the series has ended. ${this.metron.usageToday()} of today’s 5,000 requests used.`
          : 'No token. Optional: looks up single comic issues (free account).',
      },
      {
        ...this.comicvine.client.status(),
        label: SOURCE_LABELS.comicvine,
        configured: this.comicvine.configured(),
        note: this.comicvine.configured()
          ? 'Key saved. Asked only for comic issues Metron can’t find (200 requests an hour).'
          : 'No key. Optional: a fallback for comic issues Metron can’t find (free account).',
      },
    ];
  }

  private client(name: SourceName) {
    if (name === 'openlibrary') return this.openlibrary.client;
    if (name === 'anilist') return this.anilist.client;
    if (name === 'hardcover') return this.hardcover.client;
    if (name === 'metron') return this.metron.client;
    if (name === 'comicvine') return this.comicvine.client;
    return null;
  }

  /**
   * Real requests sent to a source since the app started (cache reads don't count). The demo
   * source never goes online, so it always says 0.
   */
  requestCount(name: SourceName): number {
    return this.client(name)?.status().requests ?? 0;
  }

  /** The source's circuit breaker is open after repeated failures. */
  isPaused(name: SourceName): boolean {
    return this.client(name)?.status().state === 'paused';
  }

  resetBreakers(): void {
    for (const c of [
      this.openlibrary.client,
      this.anilist.client,
      this.hardcover.client,
      this.metron.client,
      this.comicvine.client,
    ])
      c.resetBreaker();
  }

  label(name: SourceName): string {
    return SOURCE_LABELS[name];
  }
}

function emptyStatus(source: SourceName): SourceStatus {
  return {
    source,
    state: 'ok',
    consecutiveFailures: 0,
    pausedUntil: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    requests: 0,
    rateLimit: {},
  };
}

// ---- Secrets (§6.3): never in backups, exports or API responses --------------------------------

export function getSecret(db: DB, name: string): string | null {
  return (
    (db.prepare('SELECT value FROM secrets WHERE name = ?').pluck().get(name) as
      string | undefined) ?? null
  );
}

export function setSecret(db: DB, name: string, value: string | null): void {
  if (value === null || value.trim() === '') {
    db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    return;
  }
  db.prepare(
    `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, value.trim(), nowIso());
}

/** "••••1234": enough to recognise which key is saved, never enough to use it. */
export function maskSecret(value: string | null): string | null {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}
