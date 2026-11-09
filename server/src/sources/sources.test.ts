import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIRCUIT_FAILURES } from '../config.ts';
import { decide, scoreCandidate, type MatchFacts } from '../identify/match.ts';
import { memoryDb } from '../testing/helpers.ts';
import { parseAniList } from './anilist.ts';
import { SourceClient } from './client.ts';
import { Hardcover, normaliseToken, parseHardcover } from './hardcover.ts';
import { OpenLibrary, parseOpenLibrary } from './openlibrary.ts';
import type { Fetcher } from './types.ts';

const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'sources');
const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;

const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  title: '',
  titleSource: 'embedded',
  authors: [],
  isbns: [],
  isbnCandidates: [],
  kind: null,
  ...over,
});

/** A fetcher that answers every request with the given JSON (or status) and records URLs. */
function fakeFetch(answer: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  return { fetcher, calls };
}

const noSleep = { sleep: async () => {} };

describe('Open Library (recorded responses)', () => {
  it('reads title, authors, first publication year, pages and a 5-star rating with its vote count', () => {
    const [first] = parseOpenLibrary(fixture('ol-search-time-machine.json'));
    expect(first).toMatchObject({
      source: 'openlibrary',
      title: 'The Time Machine',
      authors: ['H. G. Wells'],
      firstPublishYear: 1895,
      pages: 120,
      rating: { scale: 5, count: 134, scope: 'book' },
    });
    expect(first!.rating!.value).toBeCloseTo(4.01, 2);
  });

  it('returns nothing, not an error, when nothing is found', () => {
    expect(parseOpenLibrary(fixture('ol-search-none.json'))).toEqual([]);
  });

  it('identifies itself and caches the answer, so the same lookup makes no second request', async () => {
    const db = await memoryDb();
    const { fetcher, calls } = fakeFetch(fixture('ol-search-time-machine.json'));
    const ol = new OpenLibrary(db, fetcher);
    await ol.search({ title: 'The Time Machine', author: 'Wells' });
    await ol.search({ title: 'The Time Machine', author: 'Wells' });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>)['User-Agent']).toMatch(
      /whatBooksNext/,
    );
    expect(calls[0]!.url).toContain('title=The+Time+Machine');
  });
});

describe('AniList (recorded responses)', () => {
  it('gives a manga’s score as a series score out of 100, with its vote count', () => {
    const [vagabond] = parseAniList(fixture('anilist-search-vagabond.json'));
    expect(vagabond).toMatchObject({
      source: 'anilist',
      title: 'Vagabond',
      rating: { value: 91, scale: 100, scope: 'series' },
      series: { status: 'ongoing' },
      country: 'JP',
    });
    expect(vagabond!.rating!.count).toBeGreaterThan(1000);
  });

  it('keeps the romaji and other titles for matching', () => {
    const [yotsuba] = parseAniList(fixture('anilist-search-yotsuba.json'));
    expect(yotsuba!.title).toBe('Yotsuba&!');
    expect(yotsuba!.alternativeTitles).toContain('Yotsuba to!');
  });

  it('never invents a rating for a manga without a score', () => {
    const records = parseAniList(fixture('anilist-search-vagabond.json'));
    const unscored = records.find((r) => r.sourceId === '125401');
    expect(unscored?.rating).toBeUndefined();
  });
});

describe('Hardcover', () => {
  // Built from the shape in Hardcover's docs; the owner's Test Hardcover run confirms it (M3).
  const payload = {
    data: {
      search: {
        results: {
          found: 1,
          hits: [
            {
              document: {
                id: 123,
                title: 'Example Book',
                author_names: ['Ann Author'],
                rating: 4.12,
                ratings_count: 900,
                release_year: 2001,
                pages: 320,
                isbns: ['9780000000002'],
                genres: ['Fantasy'],
                slug: 'example-book',
                featured_series: {
                  position: 2,
                  series: { name: 'Example Saga', books_count: 3, is_completed: true },
                },
              },
            },
          ],
        },
      },
    },
  };

  it('reads rating, count, pages and series position from a search result', () => {
    expect(parseHardcover(payload)[0]).toMatchObject({
      sourceId: '123',
      rating: { value: 4.12, scale: 5, count: 900, scope: 'book' },
      pages: 320,
      series: { name: 'Example Saga', position: 2, total: 3, status: 'finished' },
    });
  });

  it('accepts a pasted token with or without "Bearer"', () => {
    expect(normaliseToken('  Bearer abc.def ')).toBe('abc.def');
    expect(normaliseToken('abc.def')).toBe('abc.def');
  });

  it('sends the token only in the authorization header, never in the URL', async () => {
    const { fetcher, calls } = fakeFetch(payload);
    const hc = new Hardcover(null, () => 'Bearer secret-token', fetcher);
    await hc.search({ title: 'Example Book', author: 'Ann Author' });
    expect(calls[0]!.url).not.toContain('secret');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('remembers today’s request count across a restart of the app', async () => {
    const db = await memoryDb();
    const { fetcher } = fakeFetch(payload);
    const first = new Hardcover(db, () => 'token', fetcher);
    await first.search({ title: 'One' });
    await first.search({ title: 'Two' });
    // A cached answer costs nothing.
    await first.search({ title: 'Two' });
    const afterRestart = new Hardcover(db, () => 'token', fetcher);
    expect(afterRestart.usageToday()).toBe(2);
  });

  it('refuses to look anything up without a token', async () => {
    const hc = new Hardcover(null, () => null);
    await expect(hc.search({ title: 'x' })).rejects.toThrow(/No Hardcover token/);
  });
});

describe('the source client', () => {
  it('pauses a source after repeated failures instead of hammering it', async () => {
    const { fetcher, calls } = fakeFetch({ error: 'down' }, 503);
    const c = new SourceClient({ name: 'openlibrary', minIntervalMs: 0, fetcher, ...noSleep });
    for (let i = 0; i < CIRCUIT_FAILURES + 3; i++)
      await c.json('https://example.invalid/x', {}, null).catch(() => undefined);
    expect(calls).toHaveLength(CIRCUIT_FAILURES);
    expect(c.status().state).toBe('paused');
  });

  it('waits as long as a 429 asks, then tries once more', async () => {
    let n = 0;
    const waits: number[] = [];
    const fetcher: Fetcher = async () =>
      ++n === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '7' } })
        : new Response('{"ok":1}', { status: 200 });
    let now = 1_000_000;
    const c = new SourceClient({
      name: 'anilist',
      minIntervalMs: 0,
      fetcher,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await expect(c.json('https://example.invalid', {}, null)).resolves.toEqual({ ok: 1 });
    expect(waits).toEqual([7000]);
  });

  it('keeps requests at least the minimum interval apart', async () => {
    const { fetcher } = fakeFetch({});
    let now = 0;
    const waits: number[] = [];
    const c = new SourceClient({
      name: 'openlibrary',
      minIntervalMs: 1000,
      fetcher,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await Promise.all([1, 2, 3].map((i) => c.json(`https://example.invalid/${i}`, {}, null)));
    expect(waits).toEqual([1000, 1000]);
  });
});

describe('matching (§11.2)', () => {
  const tm = parseOpenLibrary(fixture('ol-search-time-machine.json'));
  const pp = parseOpenLibrary(fixture('ol-search-pride-prejudice.json'));

  it('accepts an exact title with an agreeing author', () => {
    const r = decide(facts({ title: 'The Time Machine', authors: ['Wells, H.G.'] }), tm);
    expect(r.decision).toBe('accepted');
    expect(r.best!.record.title).toBe('The Time Machine');
  });

  it('matches a run-together filename title by ignoring spaces and the leading article', () => {
    const s = scoreCandidate(
      facts({ title: 'Timemachine', rawTitle: 'thetimemachine', titleSource: 'filename' }),
      tm[0]!,
    );
    expect(s.evidence.title).toBe(1);
  });

  it('only provisionally accepts a filename title with no author to check', () => {
    const r = decide(facts({ title: 'The Time Machine', titleSource: 'filename' }), tm);
    expect(r.decision).toBe('provisional');
  });

  it('never accepts an exact title whose author disagrees', () => {
    const r = decide(facts({ title: 'The Time Machine', authors: ['Someone Else'] }), tm);
    expect(r.decision).toBe('unidentified');
  });

  it('treats the same work entered twice at a source as one work, not a tie', () => {
    const r = decide(facts({ title: 'Pride and Prejudice', authors: ['Jane Austen'] }), pp);
    expect(r.decision).toBe('accepted');
    // The better-documented record wins.
    expect(r.best!.record.rating!.count).toBe(416);
  });

  it('leaves two different works scoring within 0.05 as a tie, with neither accepted (scenario 18)', () => {
    const a = { ...tm[0]!, sourceId: '/works/A', title: 'The Glass Bell', authors: [] };
    const b = { ...tm[0]!, sourceId: '/works/B', title: 'The Glass Bells', authors: ['Other'] };
    const r = decide(facts({ title: 'The Glass Bell', titleSource: 'filename' }), [a, b]);
    expect(r.decision).toBe('tie');
    expect(r.best).toBeNull();
    expect(r.ranked).toHaveLength(2);
  });

  it('never accepts a candidate the owner rejected', () => {
    const r = decide(
      facts({ title: 'The Time Machine', authors: ['H. G. Wells'] }),
      tm,
      new Set([`openlibrary:${tm[0]!.sourceId}`]),
    );
    expect(r.best?.record.sourceId).not.toBe(tm[0]!.sourceId);
  });

  it('accepts an EPUB’s own ISBN but treats a PDF’s ISBN only as corroboration', () => {
    const isbn = parseOpenLibrary(fixture('ol-search-isbn.json'));
    const own = isbn[0]!.isbns[0]!;
    expect(decide(facts({ title: 'Pride & Prejudice', isbns: [own] }), isbn).decision).toBe(
      'accepted',
    );
    const pdf = scoreCandidate(
      facts({ title: 'Some Other Title Entirely', isbnCandidates: [own] }),
      isbn[0]!,
    );
    expect(pdf.score).toBeLessThan(0.6);
  });
});
