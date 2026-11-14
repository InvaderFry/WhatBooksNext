import { METRON_DAILY_LIMIT, METRON_MIN_INTERVAL_MS, METRON_RUN_SEARCHES } from '../config.ts';
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
import { sourceCoverUrl } from './covers.ts';
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
 * The issue filters used here (series_name, number, and series_year_began and series_volume to
 * find one run) and the response shapes come from that library, not from a live answer: the
 * owner's Diagnostics → Test Metron run confirms them. A filter Metron ignored would only repeat
 * the plain answer.
 */

export const METRON_API = 'https://metron.cloud/api';

/** Metron's site; the token is made on the owner's account page there. */
export const METRON_SITE = 'https://metron.cloud/';

interface MetronIssue {
  image?: string | null;
  id?: number;
  number?: string;
  issue?: string;
  cover_date?: string | null;
  store_date?: string | null;
  publisher?: { name?: string };
  series?: { id?: number; name?: string; volume?: number; year_began?: number };
}

interface MetronSeries {
  publisher?: { name?: string };
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

/** Series types that collect issues rather than publish them (Metron's own names). */
export const COLLECTED_TYPE = /trade paperback|graphic novel|hard ?cover|omnibus|collect/i;

/** A series name without a "TPB" / "Omnibus" tag, for comparing with ours. */
const baseKey = (name: string) =>
  titleCompareKey(name.replace(/\b(tpb|trade paperback|hc|hardcover|omnibus)\b/gi, ' '));

/** "Action Comics (1938) #193" → series, year, number. */
export function parseReprint(s: string): { series: string; year?: number; number: string } | null {
  const m = /^(.+?)\s*(?:\((\d{4})\))?\s*#\s*(\S+)\s*$/.exec(s.trim());
  if (!m) return null;
  return { series: m[1]!.trim(), ...(m[2] ? { year: Number(m[2]) } : {}), number: m[3]! };
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
    const collected = COLLECTED_TYPE.test(s?.series_type?.name ?? '');
    const rec: SourceRecord = {
      source: 'metron',
      sourceId: String(i.id),
      coverUrl: sourceCoverUrl('metron', i.image),
      title: collected ? `${i.series.name} Vol. ${i.number}` : `${i.series.name} #${i.number}`,
      authors: [],
      ...(typeof (s?.publisher?.name ?? i.publisher?.name) === 'string'
        ? { publisher: (s?.publisher?.name ?? i.publisher?.name)!.trim() || undefined }
        : {}),
      isbns: [],
      // Says it's a comic, so the matching treats it as one (comicLike).
      subjects: ['Comics', ...(s?.series_type?.name ? [s.series_type.name] : [])],
      format: collected ? 'COLLECTED' : 'ISSUE',
      series: {
        name: i.series.name,
        ...(typeof i.series.id === 'number' ? { id: String(i.series.id) } : {}),
        ...(typeof i.series.year_began === 'number'
          ? { startYear: i.series.year_began }
          : typeof s?.year_began === 'number'
            ? { startYear: s.year_began }
            : {}),
        ...(typeof i.series.volume === 'number' && i.series.volume > 0
          ? { volume: i.series.volume }
          : {}),
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
   * By series name and number. A single issue's query keeps ongoing and limited series; a
   * collected volume's keeps trade paperbacks, hardcovers, graphic novels and omnibuses, and
   * reads what they reprint (§12.5). Each series matching the name is read once (cached) for
   * its type, whether it has ended and how many issues it has.
   */
  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const series = q.series ?? q.title;
    const number = q.issue ?? q.volume;
    if (!series || !number) return [];
    const collected = !q.issue;
    const params = new URLSearchParams({ series_name: series, number });
    const key = `issues:${series.toLowerCase()}|${number.toLowerCase()}`;
    const payload = await this.get(`issue/?${params}`, key, Boolean(opts.refresh));
    const want = baseKey(series);
    const results = [...((payload as { results?: MetronIssue[] } | null)?.results ?? [])];
    // Many runs share a name and number ("Copperline #1" from 1992, 2014 and 2019), and the first
    // page of answers may hold none from the file's run. Ask by the run's start year or series
    // volume then: once each, cached, and only while the run is still missing.
    const ofRun = (i: MetronIssue) =>
      baseKey(i.series?.name ?? '') === want &&
      ((q.seriesVolume !== undefined && String(i.series?.volume) === q.seriesVolume) ||
        (q.years ?? []).some((y) => y === i.series?.year_began || y === year(i.cover_date)));
    const runAsks = [
      ...(q.seriesVolume ? [['series_volume', q.seriesVolume]] : []),
      ...(q.years ?? []).map((y) => ['series_year_began', String(y)]),
    ].slice(0, METRON_RUN_SEARCHES);
    for (const [filter, value] of runAsks) {
      if (results.some(ofRun)) break;
      const more = (await this.get(
        `issue/?${new URLSearchParams({ series_name: series, number, [filter!]: value! })}`,
        `${key}|${filter}=${value}`,
        Boolean(opts.refresh),
      )) as { results?: MetronIssue[] } | null;
      const seen = new Set(results.map((i) => i.id));
      results.push(...(more?.results ?? []).filter((i) => !seen.has(i.id)));
    }
    const ids = [
      ...new Set(
        results
          .filter((i) => i?.series?.name && baseKey(i.series.name) === want)
          .map((i) => i.series!.id)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ].slice(0, 6);
    const details = new Map<number, MetronSeries>();
    for (const id of ids) {
      try {
        details.set(id, (await this.get(`series/${id}/`, `series:${id}`, false)) as MetronSeries);
      } catch {
        // The series' details are a nice-to-have: the issue match stands without them.
      }
    }
    const typeOf = (i: MetronIssue) =>
      typeof i.series?.id === 'number' ? details.get(i.series.id)?.series_type?.name : undefined;
    // A collected edition is never a single issue's match, and the other way round. A series
    // whose type we couldn't read stays in for issues (most series publish issues) and out
    // for collections.
    const kept = results.filter((i) => {
      const t = typeOf(i);
      return collected ? t !== undefined && COLLECTED_TYPE.test(t) : !t || !COLLECTED_TYPE.test(t);
    });
    const recs = parseMetronIssues({ results: kept }, details);
    if (collected)
      for (const r of recs.slice(0, 2)) {
        try {
          const d = (await this.get(`issue/${r.sourceId}/`, `issue:${r.sourceId}`, false)) as {
            reprints?: { issue?: string }[];
          };
          const collects = (d?.reprints ?? [])
            .map((x) => (typeof x?.issue === 'string' ? parseReprint(x.issue) : null))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (collects.length) r.collects = collects;
        } catch {
          // What it reprints is a suggestion only; the volume's match stands without it.
        }
      }
    return recs;
  }
}
