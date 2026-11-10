import { METRON_DAILY_LIMIT, METRON_MIN_INTERVAL_MS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { SourceClient } from './client.ts';
import {
  SourceError,
  type Fetcher,
  type SourceAdapter,
  type SourceQuery,
  type SourceRecord,
} from './types.ts';
import { DailyUsage } from './usage.ts';

/**
 * Metron (§12.1): comics — series, issues, cover dates, and whether a series has ended. Needs
 * the owner's free account and an API token from its account page.
 *
 * Checked in November 2026 against Metron's own client library (Mokkari 5.0), because
 * metron.cloud's docs refuse automated reads:
 *  - REST at https://metron.cloud/api/{resource}/, token sent as `Authorization: Bearer …`
 *    (username/password logins were removed in Mokkari 5.0);
 *  - a burst limit of at least 20 requests a minute and 5,000 a day, reported in the
 *    X-RateLimit-Burst-* and X-RateLimit-Sustained-* headers (resets in epoch seconds);
 *  - lists are paginated as { count, next, previous, results };
 *  - an issue in a list has id, number, series { id, name, volume, year_began }, cover_date and
 *    store_date; a series has status ("Completed", "Ongoing", …), issue_count, year_began and
 *    year_end. Metron's data is licensed CC BY-SA 4.0 and is shown as Metron's.
 *
 * The issue filters used here (series_name, number) and the response shapes come from that
 * library, not from a live answer: the owner's Diagnostics → Test Metron run confirms them.
 */

export const METRON_API = 'https://metron.cloud/api';

/** Metron's site; the token is made on the owner's account page there. */
export const METRON_SITE = 'https://metron.cloud/';

interface MetronIssue {
  id?: number;
  number?: string;
  issue?: string;
  cover_date?: string | null;
  store_date?: string | null;
  series?: { id?: number; name?: string; volume?: number; year_began?: number };
}

interface MetronSeries {
  id?: number;
  name?: string;
  status?: string;
  issue_count?: number;
  year_began?: number;
  year_end?: number | null;
  series_type?: { name?: string };
  resource_url?: string;
}

const year = (d: string | null | undefined): number | undefined => {
  const m = /^(\d{4})-/.exec(d ?? '');
  const y = m ? Number(m[1]) : NaN;
  return Number.isFinite(y) && y > 1800 ? y : undefined;
};

/** "Completed" and "Cancelled" stories won't continue; "Ongoing" and "Hiatus" may. */
export function metronStatus(s: string | undefined): 'finished' | 'ongoing' | 'unknown' {
  const v = (s ?? '').toLowerCase();
  if (v === 'completed' || v === 'cancelled' || v === 'canceled') return 'finished';
  if (v === 'ongoing' || v === 'hiatus') return 'ongoing';
  return 'unknown';
}

export function parseMetronIssues(
  payload: unknown,
  series: Map<number, MetronSeries> = new Map(),
): SourceRecord[] {
  const results = (payload as { results?: MetronIssue[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SourceRecord[] = [];
  for (const i of results) {
    if (typeof i?.id !== 'number' || !i.number || !i.series?.name) continue;
    const s = typeof i.series.id === 'number' ? series.get(i.series.id) : undefined;
    const cover = year(i.cover_date) ?? year(i.store_date);
    const years = [cover, i.series.year_began].filter((y): y is number => typeof y === 'number');
    const position = /^\d+(\.\d+)?$/.test(i.number) ? parseFloat(i.number) : undefined;
    const status = metronStatus(s?.status);
    const rec: SourceRecord = {
      source: 'metron',
      sourceId: String(i.id),
      title: `${i.series.name} #${i.number}`,
      authors: [],
      isbns: [],
      // Says it's a comic, so the matching treats it as one (comicLike).
      subjects: ['Comics', ...(s?.series_type?.name ? [s.series_type.name] : [])],
      format: 'ISSUE',
      series: {
        name: i.series.name,
        ...(typeof i.series.id === 'number' ? { id: String(i.series.id) } : {}),
        ...(position !== undefined ? { position } : {}),
        status,
        // An issue count is only the story's length once it has ended.
        ...(status === 'finished' && typeof s?.issue_count === 'number' && s.issue_count > 0
          ? { total: s.issue_count }
          : {}),
      },
    };
    if (cover) rec.firstPublishYear = cover;
    if (years.length) rec.years = [...new Set(years)];
    if (s?.resource_url && /^https:\/\/metron\.cloud\//.test(s.resource_url))
      rec.url = s.resource_url;
    out.push(rec);
  }
  return out;
}

export class Metron implements SourceAdapter {
  readonly name = 'metron' as const;
  readonly client: SourceClient;
  private readonly getToken: () => string | null;
  private readonly usage: DailyUsage;

  constructor(db: DB | null, getToken: () => string | null, fetcher?: Fetcher) {
    this.getToken = getToken;
    this.usage = new DailyUsage(db, 'metronUsage');
    this.client = new SourceClient({
      name: 'metron',
      minIntervalMs: METRON_MIN_INTERVAL_MS,
      db,
      fetcher,
    });
  }

  configured(): boolean {
    return !!this.getToken();
  }

  usageToday(): number {
    return this.usage.today();
  }

  /** One GET, from the cache when we have it; counts against the day only when sent. */
  private async get(path: string, key: string, refresh: boolean): Promise<unknown> {
    const token = this.getToken();
    if (!token) throw new SourceError('metron', 'No Metron token in Settings.', false);
    if (!refresh) {
      const hit = this.client.cached(key);
      if (hit !== undefined) return hit;
    }
    if (this.usage.today() >= METRON_DAILY_LIMIT - 200)
      throw new SourceError(
        'metron',
        'Reached today’s Metron allowance; carrying on tomorrow.',
        true,
      );
    this.usage.count();
    return this.client.json(
      `${METRON_API}/${path}`,
      { headers: { authorization: `Bearer ${token.trim().replace(/^bearer\s+/i, '')}` } },
      key,
      { refresh: true },
    );
  }

  /**
   * Single issues by series name and number. Each series found that matches the name is then
   * read once (cached) for whether it has ended and how many issues it has.
   */
  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const series = q.series ?? q.title;
    if (!series || !q.issue) return [];
    const params = new URLSearchParams({ series_name: series, number: q.issue });
    const key = `issues:${series.toLowerCase()}|${q.issue.toLowerCase()}`;
    const payload = await this.get(`issue/?${params}`, key, Boolean(opts.refresh));
    const want = titleCompareKey(series);
    const ids = [
      ...new Set(
        ((payload as { results?: MetronIssue[] } | null)?.results ?? [])
          .filter((i) => i?.series?.name && titleCompareKey(i.series.name) === want)
          .map((i) => i.series!.id)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ].slice(0, 3);
    const details = new Map<number, MetronSeries>();
    for (const id of ids) {
      try {
        details.set(id, (await this.get(`series/${id}/`, `series:${id}`, false)) as MetronSeries);
      } catch {
        // The series' status is a nice-to-have: the issue match stands without it.
      }
    }
    return parseMetronIssues(payload, details);
  }
}
