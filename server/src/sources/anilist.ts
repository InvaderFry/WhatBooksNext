import { ANILIST_MIN_INTERVAL_MS, SEARCH_RESULTS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { SourceClient } from './client.ts';
import type { Fetcher, SourceAdapter, SourceQuery, SourceRecord } from './types.ts';

/**
 * AniList (§12.1): keyless GraphQL for manga — score, genres, tags, volumes, publication
 * status. Checked live in November 2026: no key needed for public queries, and the API
 * answered with X-RateLimit-Limit: 30 a minute (its documented 90 is lowered at times), so
 * the client spaces requests and obeys the headers. AniList's docs site refused automated
 * reads, so its terms couldn't be checked here — listed in the M3 notes.
 *
 * AniList scores a whole manga, never a volume: its rating is always scope "series" (§12.2).
 */

const QUERY = `query ($s: String, $p: Int) {
  Page(perPage: $p) {
    media(search: $s, type: MANGA, sort: SEARCH_MATCH) {
      id siteUrl format status volumes averageScore popularity countryOfOrigin
      startDate { year }
      title { romaji english native }
      synonyms genres
      tags { name rank isGeneralSpoiler }
      stats { scoreDistribution { score amount } }
      staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
    }
  }
}`;

interface Media {
  id: number;
  siteUrl?: string;
  format?: string;
  status?: string;
  volumes?: number | null;
  averageScore?: number | null;
  countryOfOrigin?: string;
  startDate?: { year?: number | null };
  title?: { romaji?: string | null; english?: string | null; native?: string | null };
  synonyms?: string[];
  genres?: string[];
  tags?: { name: string; rank: number; isGeneralSpoiler: boolean }[];
  stats?: { scoreDistribution?: { score: number; amount: number }[] };
  staff?: { edges?: { role: string; node: { name: { full: string } } }[] };
}

const STATUS: Record<string, 'finished' | 'ongoing' | 'unknown'> = {
  FINISHED: 'finished',
  RELEASING: 'ongoing',
  HIATUS: 'ongoing',
  NOT_YET_RELEASED: 'unknown',
  CANCELLED: 'finished',
};

export function parseAniList(payload: unknown): SourceRecord[] {
  const media = (payload as { data?: { Page?: { media?: Media[] } } } | null)?.data?.Page?.media;
  if (!Array.isArray(media)) return [];
  return media
    .filter((m) => m && typeof m.id === 'number')
    .map((m) => {
      const title = m.title?.english || m.title?.romaji || m.title?.native || '';
      const votes = (m.stats?.scoreDistribution ?? []).reduce((a, s) => a + (s.amount ?? 0), 0);
      const r: SourceRecord = {
        source: 'anilist',
        sourceId: String(m.id),
        title,
        authors: (m.staff?.edges ?? [])
          .filter((e) => /story|art|original/i.test(e.role))
          .map((e) => e.node.name.full),
        isbns: [],
        subjects: [
          ...(m.genres ?? []),
          ...(m.tags ?? []).filter((t) => !t.isGeneralSpoiler && t.rank >= 60).map((t) => t.name),
        ],
        format: m.format,
        country: m.countryOfOrigin,
        url: m.siteUrl,
      };
      const alt = [m.title?.romaji, m.title?.english, ...(m.synonyms ?? [])].filter(
        (t): t is string => !!t && t !== title,
      );
      // The other titles help matching: a file may use the romaji or the English name.
      if (alt.length) r.alternativeTitles = alt;
      if (m.startDate?.year) r.firstPublishYear = m.startDate.year;
      if (typeof m.averageScore === 'number')
        r.rating = { value: m.averageScore, scale: 100, count: votes || null, scope: 'series' };
      r.series = {
        name: title,
        status: STATUS[m.status ?? ''] ?? 'unknown',
        ...(m.volumes && m.status === 'FINISHED' ? { total: m.volumes } : {}),
      };
      return r;
    });
}

export class AniList implements SourceAdapter {
  readonly name = 'anilist' as const;
  readonly client: SourceClient;
  constructor(db: DB | null, fetcher?: Fetcher) {
    this.client = new SourceClient({
      name: 'anilist',
      minIntervalMs: ANILIST_MIN_INTERVAL_MS,
      db,
      fetcher,
    });
  }

  async search(q: SourceQuery, opts: { refresh?: boolean } = {}): Promise<SourceRecord[]> {
    const s = q.series ?? q.title;
    const payload = await this.client.json(
      'https://graphql.anilist.co',
      { method: 'POST', body: { query: QUERY, variables: { s, p: SEARCH_RESULTS } } },
      `search:${s.toLowerCase()}`,
      opts,
    );
    return parseAniList(payload);
  }
}
