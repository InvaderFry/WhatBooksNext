import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, type MatchFacts } from '../identify/match.ts';
import { memoryDb } from '../testing/helpers.ts';
import { ComicVine, parseComicVineIssues } from './comicvine.ts';
import { Metron, metronStatus, parseMetronIssues } from './metron.ts';
import { Sources, setSecret } from './index.ts';
import type { Fetcher } from './types.ts';

/** Metron and ComicVine (M4), against invented answers in their documented shapes. */

const DIR = path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'sources', 'synthetic');
const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as unknown;

const issueFacts = (over: Partial<MatchFacts> = {}): MatchFacts => ({
  title: 'Copperline #2',
  titleSource: 'embedded',
  authors: [],
  seriesHint: 'Copperline',
  issue: '2',
  isbns: [],
  isbnCandidates: [],
  kind: 'comic',
  ...over,
});

/** Answers by URL path; records every URL and header. */
function router(routes: Record<string, unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const body = routes[u.pathname] ?? { status_code: 101, error: 'Object Not Found', results: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, calls };
}

describe('Metron (§12.1)', () => {
  it('reads an issue’s series, number and years, and the series’ status and length', () => {
    const series = new Map([[9001, fixture('metron-series-9001.json') as { id: number }]]);
    const [first, second] = parseMetronIssues(fixture('metron-issues-copperline-2.json'), series);
    expect(first).toMatchObject({
      source: 'metron',
      sourceId: '900002',
      title: 'Copperline #2',
      format: 'ISSUE',
      firstPublishYear: 2019,
      years: [2019],
      series: { name: 'Copperline', position: 2, status: 'finished', total: 6 },
    });
    // No series details read for the other run: its status stays unknown, never guessed.
    expect(second!.series).toEqual({
      name: 'Copperline',
      id: '9002',
      position: 2,
      status: 'unknown',
    });
    expect(second!.years).toEqual([2023]);
  });

  it('counts a cancelled series as ended and a hiatus as ongoing', () => {
    expect(metronStatus('Completed')).toBe('finished');
    expect(metronStatus('Cancelled')).toBe('finished');
    expect(metronStatus('Hiatus')).toBe('ongoing');
    expect(metronStatus('Ongoing')).toBe('ongoing');
    expect(metronStatus(undefined)).toBe('unknown');
  });

  it('searches by series name and number with the token, and reads each series only once', async () => {
    const db = await memoryDb();
    const { fetcher, calls } = router({
      '/api/issue/': fixture('metron-issues-copperline-2.json'),
      '/api/series/9001/': fixture('metron-series-9001.json'),
      '/api/series/9002/': fixture('metron-series-9002.json'),
    });
    const m = new Metron(db, () => 'tok-1234567890abcdef', fetcher);
    (m.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await m.search({ title: 'Copperline 2', series: 'Copperline', issue: '2' });
    expect(recs.map((r) => r.series?.status)).toEqual(['finished', 'ongoing']);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe('/api/issue/');
    expect(first.searchParams.get('series_name')).toBe('Copperline');
    expect(first.searchParams.get('number')).toBe('2');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok-1234567890abcdef',
    );
    expect(calls).toHaveLength(3);
    expect(m.usageToday()).toBe(3);
    // Issue 3 of the same series: the issue list is new, the series details come from the cache.
    await m.search({ title: 'Copperline 3', series: 'Copperline', issue: '3' });
    expect(calls.map((c) => new URL(c.url).pathname).slice(3)).toEqual(['/api/issue/']);
  });

  it('accepts the issue whose year matches the file, though two runs share the name', () => {
    const recs = parseMetronIssues(fixture('metron-issues-copperline-2.json'));
    expect(decide(issueFacts({ years: [2019] }), recs)).toMatchObject({
      decision: 'accepted',
      best: { record: { sourceId: '900002' } },
    });
  });

  it('calls two runs with the same name and number a tie when the file gives no year', () => {
    const recs = parseMetronIssues(fixture('metron-issues-copperline-2.json'));
    expect(decide(issueFacts(), recs).decision).toBe('tie');
  });

  it('never takes another issue number of the same series', () => {
    const recs = parseMetronIssues(fixture('metron-issues-copperline-2.json'));
    expect(
      decide(issueFacts({ issue: '3', title: 'Copperline #3', years: [2019] }), recs).decision,
    ).toBe('unidentified');
  });
});

describe('ComicVine (§12.1)', () => {
  it('finds the run by name, then the issue in it, keeping the key out of the cache', async () => {
    const db = await memoryDb();
    const { fetcher, calls } = router({
      '/api/volumes/': fixture('comicvine-volumes-copperline.json'),
      '/api/issues/': fixture('comicvine-issues-copperline-2.json'),
    });
    const cv = new ComicVine(db, () => 'cvkey0123456789abcdef', fetcher);
    (cv.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await cv.search({ title: 'Copperline 2', series: 'Copperline', issue: '2' });
    expect(recs[0]).toMatchObject({
      source: 'comicvine',
      title: 'Copperline #2',
      subtitle: 'The Second Shift',
      years: [2019],
      series: { name: 'Copperline', position: 2, status: 'unknown' },
    });
    const issues = new URL(calls[1]!.url);
    expect(issues.searchParams.get('filter')).toBe('volume:77001,issue_number:2');
    expect(issues.searchParams.get('format')).toBe('json');
    const cached = db
      .prepare("SELECT key, payload FROM source_cache WHERE source = 'comicvine'")
      .all() as {
      key: string;
      payload: string;
    }[];
    expect(cached).toHaveLength(2);
    for (const c of cached) expect(`${c.key}${c.payload}`).not.toContain('cvkey0123456789abcdef');
  });

  it('says plainly when the key is wrong, without repeating the key', async () => {
    const { fetcher } = router({ '/api/volumes/': { status_code: 100, error: 'Invalid API Key' } });
    const cv = new ComicVine(null, () => 'cvkey0123456789abcdef', fetcher);
    const err = await cv
      .search({ title: 'Copperline 2', series: 'Copperline', issue: '2' })
      .catch((e: Error & { transient?: boolean }) => e);
    expect((err as Error).message).toBe(
      'ComicVine says the API key is invalid. Check it in Settings.',
    );
    expect((err as { transient: boolean }).transient).toBe(false);
  });

  it('reads issues the same way as Metron, so the same rules match them', () => {
    const recs = parseComicVineIssues(fixture('comicvine-issues-copperline-2.json'));
    expect(decide(issueFacts({ years: [2019] }), recs).decision).toBe('accepted');
  });
});

describe('which sources look up a single issue', () => {
  it('asks no one without keys, Metron with its token, and keeps ComicVine as the fallback', async () => {
    const db = await memoryDb();
    const s = new Sources(db, {});
    expect(s.forItem('comic', '12')).toEqual([]);
    setSecret(db, 'metron_token', 'tok-1234567890abcdef');
    setSecret(db, 'comicvine_key', 'cvkey0123456789abcdef');
    expect(s.forItem('comic', '12').map((x) => [x.name, Boolean(x.fallback)])).toEqual([
      ['metron', false],
      ['comicvine', true],
    ]);
    // Collected volumes still go to the book sources, which rate each volume.
    expect(s.forItem('comic', null).map((x) => x.name)).toEqual(['openlibrary']);
  });
});
