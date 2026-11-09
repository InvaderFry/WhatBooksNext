import type { DB } from '../db/database.ts';
import { nowIso } from '../util.ts';
import { AniList } from './anilist.ts';
import type { SourceStatus } from './client.ts';
import { DemoSource } from './demo.ts';
import { Hardcover } from './hardcover.ts';
import { OpenLibrary } from './openlibrary.ts';
import { SOURCE_LABELS, type Fetcher, type SourceAdapter, type SourceName } from './types.ts';

/** The configured sources. Built once per app; Hardcover reads its token on each request. */
export class Sources {
  readonly demo: boolean;
  readonly openlibrary: OpenLibrary;
  readonly anilist: AniList;
  readonly hardcover: Hardcover;
  readonly demoSource = new DemoSource();

  constructor(db: DB, opts: { demo?: boolean; fetcher?: Fetcher } = {}) {
    this.demo = Boolean(opts.demo);
    this.openlibrary = new OpenLibrary(db, opts.fetcher);
    this.anilist = new AniList(db, opts.fetcher);
    this.hardcover = new Hardcover(db, () => getSecret(db, 'hardcover_token'), opts.fetcher);
  }

  /**
   * Which sources to ask for an item (§12.1). Open Library and AniList are the keyless baseline;
   * Hardcover joins when the owner has a token.
   *  - Books: Open Library (+ Hardcover).
   *  - Manga: AniList for the series (score, status), and the book sources too, which list each
   *    volume as a book with its own rating (the owner's first run showed Hardcover does).
   *  - Comic volumes and collected editions: the book sources, which list them the same way.
   *  - Single issues ("Series #48") of anything but manga: nothing yet. Book sources only return
   *    unrelated novels with the series' name; Metron and ComicVine arrive in M4.
   */
  forItem(kind: string | null, issue: string | null = null): SourceAdapter[] {
    if (this.demo) return [this.demoSource];
    const books: SourceAdapter[] = this.hardcover.configured()
      ? [this.openlibrary, this.hardcover]
      : [this.openlibrary];
    if (kind === 'manga') return [this.anilist, ...books];
    if (issue) return [];
    return books;
  }

  /** For "Search and pick" in Needs review: every source that can answer now. */
  forSearch(kind: string | null): SourceAdapter[] {
    if (this.demo) return [this.demoSource];
    const books: SourceAdapter[] = this.hardcover.configured()
      ? [this.hardcover, this.openlibrary]
      : [this.openlibrary];
    return kind === 'manga' || kind === 'comic'
      ? [this.anilist, ...books]
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
    ];
  }

  resetBreakers(): void {
    for (const c of [this.openlibrary.client, this.anilist.client, this.hardcover.client])
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
