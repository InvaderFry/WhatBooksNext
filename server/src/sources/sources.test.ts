import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIRCUIT_FAILURES } from '../config.ts';
import { kindFromEvidence, techTitle } from '../identify/kinds.ts';
import { picturesFile } from '../identify/lookups.ts';
import {
  decide,
  decideRanked,
  numberIn,
  scoreCandidate,
  type MatchFacts,
} from '../identify/match.ts';
import { memoryDb } from '../testing/helpers.ts';
import { decodeEntities } from '../util.ts';
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

  it('never pauses a source’s lookups because its image host refused some covers', async () => {
    const fetcher: Fetcher = async (url) =>
      String(url).includes('/img/')
        ? new Response('nope', { status: 403 })
        : new Response('{"ok":1}', { status: 200 });
    const c = new SourceClient({ name: 'comicvine', minIntervalMs: 0, fetcher, ...noSleep });
    for (let i = 0; i < CIRCUIT_FAILURES + 2; i++)
      await expect(c.image(`https://example.invalid/img/${i}`, 1_000_000)).rejects.toThrow(
        'image host refused',
      );
    expect(c.status().state).not.toBe('paused');
    await expect(c.json('https://example.invalid/api', {}, null)).resolves.toEqual({ ok: 1 });
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

  it('automatically accepts at 90/100, keeps lower scores provisional and close rivals for review', () => {
    const candidate = scoreCandidate(
      facts({ title: 'The Time Machine', authors: ['Wells, H.G.'] }),
      tm[0]!,
    );
    expect(decideRanked([{ ...candidate, score: 0.9 }]).decision).toBe('accepted');
    expect(decideRanked([{ ...candidate, score: 0.899 }]).decision).toBe('provisional');
    expect(
      decideRanked([
        { ...candidate, score: 0.95 },
        { ...candidate, record: pp[0]!, score: 0.94 },
      ]).decision,
    ).toBe('tie');
  });

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

  it('treats a record with the subtitle and one without, by the same author, as one work', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined };
    const a = {
      ...base,
      sourceId: 'a',
      title: 'Ninety Lessons for Lamplighters',
      authors: ['Ivo Brandt'],
    };
    const b = {
      ...base,
      sourceId: 'b',
      title: 'Ninety Lessons for Lamplighters: Advice from the Guild',
      authors: ['Ivo Brandt'],
      rating: { value: 3.4, scale: 5, count: 20, scope: 'book' as const },
    };
    const r = decide(facts({ title: 'Ninety Lessons for Lamplighters', authors: ['Ivo Brandt'] }), [
      a,
      b,
    ]);
    expect(r.decision).toBe('accepted');
  });

  it('never fully accepts a title that matches only without its subtitle', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, authors: ['Ivo Brandt'] };
    const r = decide(facts({ title: 'Lamplighting', authors: ['Ivo Brandt'] }), [
      { ...base, sourceId: 'sequel', title: 'Lamplighting: The Second Watch' },
    ]);
    expect(r.decision).toBe('provisional');
  });

  it('keeps two different subtitles apart, even by the same author', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, authors: ['Ivo Brandt'] };
    const r = decide(facts({ title: 'Lamplighting', titleSource: 'filename' }), [
      { ...base, sourceId: 'v1', title: 'Lamplighting', subtitle: 'Volume One' },
      { ...base, sourceId: 'v2', title: 'Lamplighting', subtitle: 'Volume Two' },
    ]);
    expect(r.decision).toBe('tie');
  });

  it('leaves two different works scoring within 0.05 as a tie, with neither accepted (scenario 18)', () => {
    const a = { ...tm[0]!, sourceId: '/works/A', title: 'The Glass Bell', authors: [] };
    const b = { ...tm[0]!, sourceId: '/works/B', title: 'The Glass Bells', authors: ['Other'] };
    const r = decide(facts({ title: 'The Glass Bell', titleSource: 'filename' }), [a, b]);
    expect(r.decision).toBe('tie');
    expect(r.best).toBeNull();
    expect(r.ranked).toHaveLength(2);
  });

  it('reads a volume written as a word, so "Book Three" never ties with "Vol. 2"', () => {
    expect(numberIn('Night Harbor: Book Two')).toBe('2');
    expect(numberIn('Night Harbor, Volume Three')).toBe('3');
    expect(numberIn('The Book of Two Ways')).toBeNull();
    const base = { ...tm[0]!, isbns: [], rating: undefined, authors: ['Odo Venn'] };
    const records = [
      { ...base, sourceId: 'plain', title: 'Night Harbor' },
      { ...base, sourceId: 'v2', title: 'Night Harbor, Vol. 2: Dark Tides' },
      { ...base, sourceId: 'b3', title: 'Night Harbor: Book Three' },
    ];
    // The filename gives no number in digits, only in its title.
    const r = decide(
      facts({ title: 'Night Harbor: Book Three', titleSource: 'filename', kind: 'comic' }),
      records,
    );
    expect(r.decision).not.toBe('tie');
    expect(r.best?.record.sourceId).toBe('b3');
    expect(r.ranked.find((c) => c.record.sourceId === 'v2')!.score).toBeLessThanOrEqual(0.3);
    // A digit on one side and a word on the other are the same book.
    const same = decide(
      facts({ title: 'Night Harbor Vol. 3', titleSource: 'filename', volume: '3', kind: 'comic' }),
      [records[2]!],
    );
    expect(same.ranked[0]!.evidence.title).toBe(1);
  });

  it('keeps two different story names apart, and a series named with a number apart from one without', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, authors: ['Odo Venn'] };
    const comic = facts({
      title: 'Night Harbor: Falling Tide',
      titleSource: 'filename',
      kind: 'comic',
    });
    const plain = scoreCandidate(comic, { ...base, sourceId: 'p', title: 'Night Harbor' });
    const other = scoreCandidate(comic, {
      ...base,
      sourceId: 'v2',
      title: 'Night Harbor, Vol. 2: Dark Tides',
    });
    expect(other.score).toBeLessThanOrEqual(0.3);
    expect(other.evidence.notes.join(' ')).toMatch(/different story/);
    expect(plain.score).toBeGreaterThan(other.score);
    // A named book with no number is none of the numbered volumes, unless the story agrees.
    const artBook = facts({
      title: 'Night Harbor: Collected Sketches',
      titleSource: 'filename',
      kind: 'manga',
    });
    expect(
      scoreCandidate(artBook, { ...base, sourceId: 'v7', title: 'Night Harbor, Vol. 7' }).score,
    ).toBeLessThanOrEqual(0.3);
    expect(
      scoreCandidate(artBook, {
        ...base,
        sourceId: 'vs',
        title: 'Night Harbor, Vol. 9: Collected Sketches',
      }).score,
    ).toBeGreaterThan(0.3);
    // A prose subtitle like "A Novel" names no story.
    const novel = scoreCandidate(
      facts({ title: 'Glass Bells: A Novel', titleSource: 'filename' }),
      {
        ...base,
        sourceId: 'n',
        title: 'Glass Bells: Stories',
      },
    );
    expect(novel.score).toBeGreaterThan(0.3);

    const issue = facts({ title: 'Lantern Ward #1', titleSource: 'filename', kind: 'comic' });
    const same = scoreCandidate(issue, {
      ...base,
      authors: [],
      sourceId: 'a',
      title: 'Lantern Ward #1',
    });
    const eight = scoreCandidate(issue, {
      ...base,
      authors: [],
      sourceId: 'b',
      title: 'Lantern Ward 8 #1',
    });
    expect(eight.evidence.title).toBeLessThan(same.evidence.title);
    expect(eight.score).toBeLessThan(same.score);
  });

  it('calls several part-title matches with nothing else agreeing "not found", not a tie', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, subtitle: undefined };
    const r = decide(facts({ title: 'Pitch In: Wren Hollow', titleSource: 'filename' }), [
      { ...base, sourceId: 'a', title: 'Pitch In!', authors: ['Ada Fen'] },
      { ...base, sourceId: 'b', title: 'Pitch In', authors: ['Ivo Brask'] },
    ]);
    expect(r.decision).toBe('unidentified');
    // An exact title still asks the owner (two real runs with one name).
    const exact = decide(facts({ title: 'Pitch In', titleSource: 'filename' }), [
      { ...base, sourceId: 'a', title: 'Pitch In', authors: ['Ada Fen'] },
      { ...base, sourceId: 'b', title: 'Pitch In', authors: ['Ivo Brask'] },
    ]);
    expect(exact.decision).toBe('tie');
  });

  it('treats one book listed twice with a misspelt or HTML-encoded author as one book', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, subtitle: undefined };
    const r = decide(facts({ title: 'Cloud Widgets for Builders', titleSource: 'filename' }), [
      { ...base, sourceId: 'a', title: 'Cloud Widgets for Builders', authors: ['Kaja Wrzosód'] },
      {
        ...base,
        sourceId: 'b',
        title: 'Cloud Widgets for Builders',
        authors: [decodeEntities('Kaja Wrzos&#322;ód')],
      },
    ]);
    expect(r.decision).not.toBe('tie');
    expect(decodeEntities('A &amp; B &#x141;ódź')).toBe('A & B Łódź');
  });

  it('never matches a different volume of the same series', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined, authors: ['Rin Okabe'] };
    const records = [
      { ...base, sourceId: 'v32', title: 'Harbor Giants, Vol. 32' },
      { ...base, sourceId: 'v24', title: 'Harbor Giants, Vol. 24' },
    ];
    const r = decide(
      facts({ title: 'Harbor Giants 24', titleSource: 'filename', authors: ['Rin Okabe'] }),
      records,
    );
    expect(r.decision).toBe('accepted');
    expect(r.best!.record.sourceId).toBe('v24');
    expect(r.ranked.find((c) => c.record.sourceId === 'v32')!.score).toBeLessThan(0.6);
  });

  it('treats the same title entered twice, once without an author, as one book', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined };
    const r = decide(facts({ title: 'A Field Guide to Lanterns', titleSource: 'filename' }), [
      { ...base, sourceId: 'a', title: 'A Field Guide to Lanterns', authors: ['Mo Reyes'] },
      { ...base, sourceId: 'b', title: 'A Field Guide to Lanterns', authors: [] },
    ]);
    expect(r.decision).not.toBe('tie');
  });

  it('prefers the comic over a novel of the same name for a numbered comic volume', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined };
    const r = decide(
      facts({
        title: 'Bellwright Vol. 1',
        titleSource: 'filename',
        kind: 'comic',
        seriesHint: 'Bellwright',
        volume: '1',
      }),
      [
        {
          ...base,
          sourceId: 'novel',
          title: 'Bellwright',
          authors: ['Ada Novelist'],
          subjects: ['Fiction'],
        },
        {
          ...base,
          sourceId: 'novel2',
          title: 'Bellwright',
          authors: ['Ada Novelist', 'Ed Itor'],
          subjects: ['Medical fiction'],
        },
        {
          ...base,
          sourceId: 'comic',
          title: 'Bellwright',
          authors: ['Cal Inker'],
          subjects: ['Comic books, strips, etc.'],
        },
      ],
    );
    expect(r.decision).not.toBe('tie');
    expect(r.best?.record.sourceId ?? null).not.toMatch(/novel/);
  });

  it('treats one comic volume entered twice, with and without its arc name, as one book', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined };
    const r = decide(
      facts({
        title: 'Star Borough Vol. 2',
        titleSource: 'filename',
        kind: 'comic',
        seriesHint: 'Star Borough',
        volume: '2',
      }),
      [
        {
          ...base,
          sourceId: 'a',
          title: 'Star Borough Vol. 2: Confession',
          authors: ['Kit Bayle'],
        },
        { ...base, sourceId: 'b', title: 'Star Borough - 2', authors: [] },
        {
          ...base,
          sourceId: 'c',
          title: 'Star Borough, Vol. 2: Confession',
          authors: ['Kit Bayle'],
        },
      ],
    );
    expect(r.decision).not.toBe('tie');
    expect(r.decision).not.toBe('unidentified');
  });

  it('never takes a shared first name as the same author', () => {
    const r = decide(facts({ title: 'The Time Machine', authors: ['Herbert Stone'] }), [
      { ...tm[0]!, authors: ['Herbert Reed'] },
    ]);
    expect(r.decision).toBe('unidentified');
  });

  it('matches an author written with initials, surname first, or in full', () => {
    for (const name of ['Wells, H.G.', 'H. G. Wells', 'Herbert George Wells', 'Wells'])
      expect(decide(facts({ title: 'The Time Machine', authors: [name] }), tm).decision).toBe(
        'accepted',
      );
  });

  it('still sees a tie when two copies of one work come before a different work', () => {
    const base = { ...tm[0]!, isbns: [], rating: undefined };
    const r = decide(facts({ title: 'Quiet Water', titleSource: 'filename' }), [
      { ...base, sourceId: 'a1', title: 'Quiet Water', authors: ['Ana Reyes'] },
      { ...base, sourceId: 'a2', title: 'Quiet Water', authors: ['Ana Reyes'] },
      { ...base, sourceId: 'b', title: 'Quiet Water', authors: ['Ben Ortiz'] },
    ]);
    expect(r.decision).toBe('tie');
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

describe('kind guesses (§8)', () => {
  it('reads a graphic novel about history as a comic, not nonfiction', () => {
    expect(
      kindFromEvidence({
        subjects: ['History', 'Biography', 'Civil rights', 'Graphic novels'],
      })?.kind,
    ).toBe('comic');
  });
});

describe('files that are mostly pictures', () => {
  it('spots an image-only EPUB by its few words for its size', () => {
    const mb = 1024 ** 2;
    expect(picturesFile({ format: 'epub', word_count: 128, page_count: null, size: 50 * mb })).toBe(
      true,
    );
    expect(
      picturesFile({ format: 'epub', word_count: 80_000, page_count: null, size: 3 * mb }),
    ).toBe(false);
  });

  it('spots a lettered comic PDF but not prose', () => {
    expect(picturesFile({ format: 'pdf', word_count: 14_000, page_count: 120, size: 1 })).toBe(
      true,
    );
    expect(picturesFile({ format: 'pdf', word_count: 60_000, page_count: 200, size: 1 })).toBe(
      false,
    );
  });
});

describe('tech books by their titles', () => {
  it('spots programming titles, and leaves ordinary ones alone', () => {
    expect(techTitle('Learning Python the Patient Way')).toBe(true);
    expect(techTitle('Practical Object-Oriented Design')).toBe(true);
    expect(techTitle('The Gardens of Ostrava')).toBe(false);
  });
});
