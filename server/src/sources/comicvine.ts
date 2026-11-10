import { COMICVINE_MIN_INTERVAL_MS } from '../config.ts';
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

/**
 * ComicVine (§12.1): the comics fallback, asked only when Metron finds nothing. Needs the
 * owner's free API key.
 *
 * Checked in November 2026 against comicvine.gamespot.com/api and its documentation page, and
 * the Simyan 4.2 client library for what the docs leave out:
 *  - REST at https://comicvine.gamespot.com/api/{resource}/, with `api_key` and `format=json`
 *    as query parameters;
 *  - "200 requests per resource, per hour", with temporary blocks for too many a second;
 *    caching responses is asked for; strictly non-commercial use; credit ComicVine;
 *  - every answer has status_code (1 = OK, 100 = invalid key, 101 = not found, 107 = rate
 *    limited), error, number_of_total_results and results;
 *  - a volume (a series run) has id, name, start_year and count_of_issues; an issue has id,
 *    issue_number, name, cover_date, store_date, volume { id, name } and site_detail_url;
 *  - no ratings and no page counts.
 *
 * The filter syntax (`name:…`, `volume:1|2,issue_number:3`) comes from Simyan and the docs'
 * general description, not a live answer: the owner's Diagnostics → Test ComicVine run
 * confirms it. The key is never part of a cache key, a log line or an error message.
 */

export const COMICVINE_API = 'https://comicvine.gamespot.com/api';
export const COMICVINE_KEY_URL = 'https://comicvine.gamespot.com/api/';

interface CvEnvelope<T> {
  status_code?: number;
  error?: string;
  number_of_total_results?: number;
  results?: T;
}

interface CvVolume {
  id?: number;
  name?: string;
  start_year?: string | number | null;
  count_of_issues?: number;
}

interface CvIssue {
  id?: number;
  issue_number?: string | null;
  name?: string | null;
  cover_date?: string | null;
  store_date?: string | null;
  site_detail_url?: string | null;
  volume?: { id?: number; name?: string | null };
}

const yearOf = (v: unknown): number | undefined => {
  const m = /^(\d{4})/.exec(String(v ?? ''));
  const y = m ? Number(m[1]) : NaN;
  return Number.isFinite(y) && y > 1800 ? y : undefined;
};

function check<T>(source: CvEnvelope<T> | null): CvEnvelope<T> {
  const code = source?.status_code;
  if (code === 1) return source!;
  if (code === 100)
    throw new SourceError(
      'comicvine',
      'ComicVine says the API key is invalid. Check it in Settings.',
      false,
    );
  if (code === 107)
    throw new SourceError(
      'comicvine',
      'ComicVine’s hourly allowance is used up; trying again later.',
      true,
    );
  if (code === 101) return { ...source, results: [] as unknown as T };
  throw new SourceError(
    'comicvine',
    `ComicVine said: ${source?.error ?? 'an unexpected answer'}`,
    false,
  );
}

export function parseComicVineIssues(
  payload: unknown,
  volumes: Map<number, CvVolume> = new Map(),
): SourceRecord[] {
  const results = (payload as CvEnvelope<CvIssue[]> | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SourceRecord[] = [];
  for (const i of results) {
    const vname = i?.volume?.name;
    if (typeof i?.id !== 'number' || !i.issue_number || !vname) continue;
    const v = typeof i.volume?.id === 'number' ? volumes.get(i.volume.id) : undefined;
    const cover = yearOf(i.cover_date) ?? yearOf(i.store_date);
    const years = [cover, yearOf(v?.start_year)].filter((y): y is number => y !== undefined);
    const position = /^\d+(\.\d+)?$/.test(i.issue_number) ? parseFloat(i.issue_number) : undefined;
    const rec: SourceRecord = {
      source: 'comicvine',
      sourceId: String(i.id),
      title: `${vname} #${i.issue_number}`,
      authors: [],
      isbns: [],
      subjects: ['Comics'],
      format: 'ISSUE',
      // ComicVine doesn't say whether a run has ended.
      series: {
        name: vname,
        ...(typeof i.volume?.id === 'number' ? { id: String(i.volume.id) } : {}),
        ...(position !== undefined ? { position } : {}),
        status: 'unknown',
      },
    };
    if (i.name) rec.subtitle = i.name;
    if (cover) rec.firstPublishYear = cover;
    if (years.length) rec.years = [...new Set(years)];
    if (i.site_detail_url && /^https:\/\/comicvine\.gamespot\.com\//.test(i.site_detail_url))
      rec.url = i.site_detail_url;
    out.push(rec);
  }
  return out;
}

export class ComicVine implements SourceAdapter {
  readonly name = 'comicvine' as const;
  readonly fallback = true;
  readonly client: SourceClient;
  private readonly getKey: () => string | null;

  constructor(db: DB | null, getKey: () => string | null, fetcher?: Fetcher) {
    this.getKey = getKey;
    this.client = new SourceClient({
      name: 'comicvine',
      minIntervalMs: COMICVINE_MIN_INTERVAL_MS,
      db,
      fetcher,
    });
  }

  configured(): boolean {
    return !!this.getKey();
  }

  private async get<T>(
    resource: string,
    params: Record<string, string>,
    key: string,
    refresh: boolean,
  ): Promise<CvEnvelope<T>> {
    const apiKey = this.getKey();
    if (!apiKey) throw new SourceError('comicvine', 'No ComicVine API key in Settings.', false);
    if (!refresh) {
      const hit = this.client.cached(key) as CvEnvelope<T> | undefined;
      if (hit !== undefined && hit?.status_code === 1) return hit;
    }
    const qs = new URLSearchParams({ ...params, api_key: apiKey.trim(), format: 'json' });
    const payload = (await this.client.json(`${COMICVINE_API}/${resource}/?${qs}`, {}, null, {
      refresh: true,
    })) as CvEnvelope<T> | null;
    const ok = check(payload);
    // Only good answers are cached, under a key that never holds the API key.
    this.client.store(key, ok);
    return ok;
  }

  /** The run(s) with this name, then the issue with this number in them. */
  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const series = q.series ?? q.title;
    if (!series || !q.issue) return [];
    const refresh = Boolean(opts.refresh);
    const vols = await this.get<CvVolume[]>(
      'volumes',
      {
        // Commas, colons and bars are the filter syntax's own separators.
        filter: `name:${series.replace(/[,:|]/g, ' ').trim()}`,
        field_list: 'id,name,start_year,count_of_issues',
        limit: '20',
      },
      `volumes:${series.toLowerCase()}`,
      refresh,
    );
    const want = titleCompareKey(series);
    const runs = (vols.results ?? [])
      .filter((v) => typeof v?.id === 'number' && v.name && titleCompareKey(v.name) === want)
      .sort((a, b) => (b.count_of_issues ?? 0) - (a.count_of_issues ?? 0))
      .slice(0, 5);
    if (runs.length === 0) return [];
    const issues = await this.get<CvIssue[]>(
      'issues',
      {
        filter: `volume:${runs.map((v) => v.id).join('|')},issue_number:${q.issue}`,
        field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,volume',
        limit: '20',
      },
      `issues:${runs.map((v) => v.id).join('|')}|${q.issue.toLowerCase()}`,
      refresh,
    );
    return parseComicVineIssues(issues, new Map(runs.map((v) => [v.id!, v])));
  }
}
