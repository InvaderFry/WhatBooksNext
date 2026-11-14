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
      series: { name: 'Copperline', startYear: 2019, position: 2, status: 'finished', total: 6 },
    });
    // No series details read for the other run: its status stays unknown, never guessed.
    expect(second!.series).toEqual({
      name: 'Copperline',
      id: '9002',
      startYear: 2023,
      volume: 2,
      position: 2,
      status: 'unknown',
    });
    expect(second!.years).toEqual([2023]);
  });

  it('keeps publishers from series details, falling back to an issue publisher', () => {
    const payload = {
      results: [
        {
          id: 1,
          number: '1',
          series: { id: 10, name: 'Copperline' },
          publisher: { name: 'Issue Press' },
        },
        {
          id: 2,
          number: '1',
          series: { id: 20, name: 'Copperline' },
          publisher: { name: 'Lantern House' },
        },
        { id: 3, number: '1', series: { id: 30, name: 'Copperline' } },
      ],
    };
    const recs = parseMetronIssues(
      payload,
      new Map([[10, { publisher: { name: 'Four Color Press' } }]]),
    );
    expect(recs.map((r) => r.publisher)).toEqual(['Four Color Press', 'Lantern House', undefined]);
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

describe('telling runs of one name apart', () => {
  /** An invented Metron issue in list shape. */
  const issueOf = (id: number, name: string, number: string, volume: number, began: number) => ({
    id,
    number,
    series: { id: id * 10, name, volume, year_began: began },
    cover_date: `${began}-01-01`,
  });

  it('ranks the series itself above a spin-off that shares its main title', () => {
    const recs = parseMetronIssues({
      results: [
        issueOf(1, 'Copperline: Maximised', '5', 1, 2014),
        issueOf(2, 'Copperline', '5', 1, 1993),
      ],
    });
    const result = decide(issueFacts({ title: 'Copperline #5', issue: '5' }), recs);
    expect(result.decision).toBe('provisional');
    expect(result.best?.record.sourceId).toBe('2');
  });

  it('ranks a spin-off first when the file names the spin-off', () => {
    const recs = parseMetronIssues({
      results: [
        issueOf(1, 'Copperline: Maximised', '5', 1, 2014),
        issueOf(2, 'Copperline', '5', 1, 1993),
      ],
    });
    const facts = issueFacts({
      title: 'Copperline: Maximised #5',
      seriesHint: 'Copperline: Maximised',
      issue: '5',
    });
    expect(decide(facts, recs).best?.record.sourceId).toBe('1');
  });

  it('keeps a story name after the volume number the same series', () => {
    const facts = issueFacts({ title: 'Copperline Vol. 6', issue: null, volume: '6' });
    const rec = {
      source: 'hardcover' as const,
      sourceId: 'h6',
      title: 'Copperline, Vol. 6: Falling Sun',
      authors: [],
      isbns: [],
      subjects: ['Comics'],
    };
    expect(decide(facts, [rec]).best?.evidence.title).toBe(1);
  });

  it('settles a tie between runs by the series volume in the filename, unconfirmed', () => {
    const recs = parseMetronIssues({
      results: [
        issueOf(1, 'Copperline', '1', 1, 1984),
        issueOf(2, 'Copperline', '1', 2, 1993),
        issueOf(3, 'Copperline', '1', 4, 2001),
      ],
    });
    expect(decide(issueFacts({ title: 'Copperline v4 #1', issue: '1' }), recs).decision).toBe(
      'tie',
    );
    const result = decide(
      issueFacts({ title: 'Copperline v4 #1', issue: '1', runVolume: 4 }),
      recs,
    );
    expect(result).toMatchObject({ decision: 'provisional', best: { record: { sourceId: '3' } } });
    expect(result.best?.evidence.notes).toContain('Series volume matches.');
    expect(result.ranked[1]!.score).toBeLessThan(0.6);
  });

  it('asks Metron by start year only when the plain answer lacks the file’s run', async () => {
    const db = await memoryDb();
    const plain = { results: [issueOf(14, 'Copperline', '1', 2, 2014)] };
    const byYear = { results: [issueOf(92, 'Copperline', '1', 1, 1992)] };
    const calls: URL[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = new URL(url);
      calls.push(u);
      const body = u.searchParams.get('series_year_began') === '1992' ? byYear : plain;
      return new Response(JSON.stringify(u.pathname === '/api/issue/' ? body : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const m = new Metron(db, () => 'tok-1234567890abcdef', fetcher);
    (m.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await m.search({
      title: 'Copperline',
      series: 'Copperline',
      issue: '1',
      years: [1992],
    });
    expect(recs.map((r) => r.sourceId).sort()).toEqual(['14', '92']);
    expect(
      decide(issueFacts({ title: 'Copperline #1', issue: '1', years: [1992] }), recs),
    ).toMatchObject({ decision: 'accepted', best: { record: { sourceId: '92' } } });
    // Asked again: both answers come from the cache.
    const sent = calls.filter((c) => c.pathname === '/api/issue/').length;
    await m.search({ title: 'Copperline', series: 'Copperline', issue: '1', years: [1992] });
    expect(calls.filter((c) => c.pathname === '/api/issue/').length).toBe(sent);
    // The run already in the plain answer: no extra question.
    calls.length = 0;
    await m.search({ title: 'Copperline', series: 'Copperline', issue: '1', years: [2014] });
    expect(calls.filter((c) => c.searchParams.has('series_year_began'))).toEqual([]);
  });

  it('asks Metron by series volume for a "v4" file', async () => {
    const db = await memoryDb();
    const calls: URL[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = new URL(url);
      calls.push(u);
      const body =
        u.searchParams.get('series_volume') === '4'
          ? { results: [issueOf(4, 'Copperline', '1', 4, 2001)] }
          : { results: [issueOf(1, 'Copperline', '1', 1, 1984)] };
      return new Response(JSON.stringify(u.pathname === '/api/issue/' ? body : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const m = new Metron(db, () => 'tok-1234567890abcdef', fetcher);
    (m.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await m.search({
      title: 'Copperline',
      series: 'Copperline',
      issue: '1',
      seriesVolume: '4',
    });
    expect(recs.map((r) => r.series?.volume).sort()).toEqual([1, 4]);
  });
});

describe('ComicVine (§12.1)', () => {
  it('keeps the volume publisher and leaves missing publishers unknown', () => {
    const recs = parseComicVineIssues(
      {
        results: [
          { id: 1, issue_number: '1', volume: { id: 10, name: 'Copperline' } },
          { id: 2, issue_number: '1', volume: { id: 20, name: 'Copperline' } },
        ],
      },
      new Map([[10, { publisher: { name: 'Lantern House' } }]]),
    );
    expect(recs.map((r) => r.publisher)).toEqual(['Lantern House', undefined]);
  });

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
      series: { name: 'Copperline', startYear: 2019, position: 2, status: 'unknown' },
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
    // Collected volumes go to the book sources, which rate each volume, and to Metron for what
    // they reprint.
    expect(s.forItem('comic', null).map((x) => x.name)).toEqual(['openlibrary', 'metron']);
  });
});

describe('Metron and collected editions (§12.5)', () => {
  const routes = () =>
    router({
      '/api/issue/': fixture('metron-issues-copperline-1.json'),
      '/api/series/9001/': fixture('metron-series-9001.json'),
      '/api/series/9100/': fixture('metron-series-9100.json'),
      '/api/issue/910001/': fixture('metron-issue-910001.json'),
    });

  it('finds a trade paperback for a collected volume, with the issues it reprints', async () => {
    const { fetcher } = routes();
    const m = new Metron(null, () => 'tok-1234567890abcdef', fetcher);
    (m.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await m.search({ title: 'Copperline 1', series: 'Copperline', volume: '1' });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ title: 'Copperline Vol. 1', format: 'COLLECTED' });
    expect(recs[0]!.collects).toHaveLength(6);
    expect(recs[0]!.collects![0]).toEqual({ series: 'Copperline', year: 2019, number: '1' });
  });

  it('never offers a trade paperback as a single issue’s match', async () => {
    const { fetcher } = routes();
    const m = new Metron(null, () => 'tok-1234567890abcdef', fetcher);
    (m.client as unknown as { minInterval: number }).minInterval = 0;
    const recs = await m.search({ title: 'Copperline 1', series: 'Copperline', issue: '1' });
    expect(recs.map((r) => r.sourceId)).toEqual(['900001']);
  });
});
