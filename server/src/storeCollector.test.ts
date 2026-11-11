import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleCollector, COLLECTOR_SCRIPTS, scriptPath } from '../../scripts/buildCollector.ts';
import {
  googlePlay,
  parsePlayCards,
  type PlayCard,
} from '../../tools/store-collector/adapters/googlePlay.ts';
import {
  globalcomix,
  parseGlobalComixPage,
} from '../../tools/store-collector/adapters/globalcomix.ts';
import { kindle, parseKindlePage } from '../../tools/store-collector/adapters/kindle.ts';
import { kobo, parseKoboPage } from '../../tools/store-collector/adapters/kobo.ts';
import { report } from '../../tools/store-collector/core/report.ts';
import {
  scan,
  scanCards,
  type CardScanDeps,
  type ScanDeps,
} from '../../tools/store-collector/core/scan.ts';

/**
 * The store collector core and the Kindle adapter (store purchases plan, Stage 1a), on invented
 * answers in fixtures/stores/kindle/. They prove the logic, not that the live store still looks
 * like this: owner action A2 checks that.
 */

const DIR = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'kindle');
const fixture = (name: string) => fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8');
const PAGE = new URL('https://read.amazon.com/kindle-library');

const json = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** A fake store: answers by paginationToken from the fixtures, and records every request. */
function store(pages: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    const token = new URL(url).searchParams.get('paginationToken') ?? '';
    asked.push(token);
    const page = pages[token];
    if (!page) throw new Error(`no page for ${token}`);
    return page();
  };
  return { fetch, asked };
}

const NORMAL = {
  '0': () => json(fixture('page-1')),
  '4': () => json(fixture('page-2')),
  '7': () => json(fixture('page-end')),
};

function deps(fetch: ScanDeps['fetch'], extra: Partial<ScanDeps> = {}) {
  const waits: number[] = [];
  const d: ScanDeps = {
    page: PAGE,
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: () => new Date('2026-11-11T12:00:00Z'),
    signal: new AbortController().signal,
    ...extra,
  };
  return { d, waits };
}

const withUrl = (r: Response, url: string, redirected = true) => {
  Object.defineProperty(r, 'url', { value: url });
  Object.defineProperty(r, 'redirected', { value: redirected });
  return r;
};

describe('reading a Kindle library answer', () => {
  it('keeps purchases, counts samples, subscriptions and personal documents, and sends unknown labels to review', () => {
    const one = parseKindlePage(JSON.parse(fixture('page-1')));
    expect(one.records.map((r) => r.storeRecordId)).toEqual(['INVENTED0001', 'INVENTED0002']);
    expect(one.excluded).toEqual([
      { id: 'asin:INVENTED0003', reason: 'subscription' },
      { id: 'asin:INVENTED0004', reason: 'sample' },
    ]);
    expect(one.next).toBe('4');
    expect(one.records[1]).toEqual({
      storeRecordId: 'INVENTED0002',
      idKind: 'asin',
      title: 'Lanterns Over Harrowgate',
      unit: 'book',
      acquisition: { type: 'purchase', evidence: 'originType PURCHASE, resourceType EBOOK' },
      creators: [
        { name: 'Pell Inchcape', role: 'author' },
        { name: 'Wenna Holloway', role: 'author' },
      ],
      progressPercent: 43,
      readUrl: 'https://read.amazon.com/?asin=INVENTED0002',
    });
    const two = parseKindlePage(JSON.parse(fixture('page-2')));
    expect(two.records.find((r) => r.storeRecordId === 'INVENTED0006')!.acquisition).toEqual({
      type: 'uncertain',
      evidence: 'originType FAMILY_SHARE, resourceType EBOOK',
    });
    expect(two.excluded).toEqual([{ id: 'asin:INVENTED0007', reason: 'personal_document' }]);
    expect(parseKindlePage(JSON.parse(fixture('page-end'))).next).toBeNull();
  });

  it('never reads a reading status it can’t trust: progress only', () => {
    const r = parseKindlePage(JSON.parse(fixture('page-2'))).records[0]!;
    expect(r.progressPercent).toBe(100);
    expect(r.readingStatus).toBeUndefined();
  });

  it('refuses an answer that looks different (the layout fingerprint)', () => {
    expect(() => parseKindlePage(JSON.parse(fixture('changed')))).toThrow(/itemsList/);
    expect(() => parseKindlePage({ itemsList: [{ title: 'No id' }] })).toThrow(/asin/);
  });

  it('only runs on the Kindle library page, and says where to go', () => {
    expect(kindle.checkPage(PAGE)).toEqual({ ok: true, region: 'read.amazon.com' });
    const wrong = kindle.checkPage(new URL('https://www.amazon.com/gp/your-account'));
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.message).toMatch(/read\.amazon\.com\/kindle-library/);
  });
});

describe('scanning a library', () => {
  it('reads every page, slowly, and ends complete with counts that add up', async () => {
    const s = store(NORMAL);
    const { d, waits } = deps(s.fetch);
    const r = await scan(kindle, d);
    expect(s.asked).toEqual(['0', '4', '7']);
    expect(waits).toEqual([2000, 2000]);
    expect(r.envelope).toMatchObject({
      format: 'whatBooksNext-store-purchases',
      formatVersion: 1,
      service: 'kindle',
      adapterVersion: '1',
      source: { type: 'collector' },
      collectedAt: '2026-11-11T12:00:00.000Z',
      region: 'read.amazon.com',
      completion: { status: 'complete', reason: 'finished' },
      counts: {
        seen: 7,
        included: 3,
        uncertain: 1,
        excluded: { subscription: 1, sample: 1, personal_document: 1 },
      },
    });
    expect(r.envelope.records).toHaveLength(4);
    expect(r.stats.fingerprint).toBe('passed');
  });

  it('takes the longer pause after every 50 requests', async () => {
    const pages: Record<string, () => Response> = {};
    for (let i = 0; i < 4; i++)
      pages[String(i)] = () =>
        json(
          JSON.stringify({
            itemsList: [{ asin: `INVENTED9${i}`, title: `Book ${i}`, originType: 'PURCHASE' }],
            paginationToken: i < 3 ? String(i + 1) : undefined,
          }),
        );
    pages['4'] = () => json(fixture('page-end'));
    const { d, waits } = deps(store(pages).fetch, { limits: { pauseEvery: 2 } });
    await scan(kindle, d);
    expect(waits).toEqual([2000, 30000, 2000]);
  });

  it('keeps every book seen when the same book comes on two pages', async () => {
    const { d } = deps(
      store({
        ...NORMAL,
        '4': () =>
          json(fixture('page-1').replace('"paginationToken": "4"', '"paginationToken": "7"')),
      }).fetch,
    );
    const r = await scan(kindle, d);
    expect(r.envelope.records.map((x) => x.storeRecordId)).toEqual([
      'INVENTED0001',
      'INVENTED0002',
    ]);
    // The repeated page brought nothing new once; that alone isn't a stall.
    expect(r.envelope.completion.status).toBe('complete');
  });

  it('stops as partial when the store repeats a page, never looping', async () => {
    const { d } = deps(
      store({
        '0': () => json(fixture('page-1')),
        '4': () =>
          json(fixture('page-2').replace('"paginationToken": "7"', '"paginationToken": "0"')),
      }).fetch,
    );
    const r = await scan(kindle, d);
    expect(r.envelope.completion).toMatchObject({ status: 'partial', reason: 'error' });
    expect(r.envelope.completion.text).toMatch(/same page twice/);
    expect(r.envelope.records).toHaveLength(4);
  });

  it('stops as partial when pages keep bringing nothing new', async () => {
    const empty = (next: string) => () =>
      json(
        JSON.stringify({
          itemsList: [{ asin: 'INVENTED0001', title: 'Again', originType: 'PURCHASE' }],
          paginationToken: next,
        }),
      );
    const { d } = deps(store({ '0': empty('1'), '1': empty('2'), '2': empty('3') }).fetch);
    const r = await scan(kindle, d);
    expect(r.envelope.completion).toMatchObject({ status: 'partial', reason: 'error' });
    expect(r.envelope.completion.text).toMatch(/no new books/);
  });

  it('stops as partial when cancelled, keeping what was found', async () => {
    const ctrl = new AbortController();
    const s = store(NORMAL);
    const { d } = deps(s.fetch, {
      signal: ctrl.signal,
      sleep: async () => ctrl.abort(),
    });
    const r = await scan(kindle, d);
    expect(s.asked).toEqual(['0']);
    expect(r.envelope.completion).toMatchObject({ status: 'partial', reason: 'cancelled' });
    expect(r.envelope.records).toHaveLength(2);
  });

  it('stops at a sign-in page, a refusal or a check page, and never retries', async () => {
    const cases: [() => Response, string][] = [
      [() => withUrl(json('{}'), 'https://www.amazon.com/ap/signin?x=1'), 'signed_out'],
      [() => json('{}', { status: 401 }), 'signed_out'],
      [() => json('{}', { status: 403 }), 'blocked'],
      [() => json('{}', { status: 429 }), 'blocked'],
      [
        () => new Response('<html>check</html>', { headers: { 'content-type': 'text/html' } }),
        'blocked',
      ],
      [() => withUrl(json(fixture('page-2')), 'https://elsewhere.example/x'), 'blocked'],
    ];
    for (const [answer, reason] of cases) {
      const s = store({ '0': () => json(fixture('page-1')), '4': answer });
      const r = await scan(kindle, deps(s.fetch).d);
      expect(s.asked).toEqual(['0', '4']);
      expect(r.envelope.completion).toMatchObject({ status: 'partial', reason });
    }
  });

  it('fails without a file’s worth of books when the first answer looks different', async () => {
    const r = await scan(kindle, deps(store({ '0': () => json(fixture('changed')) }).fetch).d);
    expect(r.envelope.completion).toMatchObject({ status: 'failed', reason: 'layout_changed' });
    expect(r.envelope.counts.seen).toBe(0);
    expect(r.stats.fingerprint).toBe('failed');
  });

  it('stops at the safety limit as partial', async () => {
    const r = await scan(kindle, deps(store(NORMAL).fetch, { limits: { maxRequests: 2 } }).d);
    expect(r.envelope.completion).toMatchObject({ status: 'partial', reason: 'limit_reached' });
  });

  it('makes no request on the wrong page', async () => {
    const s = store(NORMAL);
    const r = await scan(kindle, deps(s.fetch, { page: new URL('https://example.com/') }).d);
    expect(s.asked).toEqual([]);
    expect(r.envelope.completion.status).toBe('failed');
  });

  it('writes a report with counts and labels but no titles, IDs or links', async () => {
    const r = await scan(kindle, deps(store(NORMAL).fetch).d);
    const text = report(kindle, r, 'Invented Browser 1');
    expect(text).toMatch(/Found: 7/);
    expect(text).toMatch(/PURCHASE\/EBOOK 3/);
    expect(text).toMatch(/Fields on the store's items: .*asin/);
    for (const x of r.envelope.records) {
      expect(text).not.toContain(x.title);
      expect(text).not.toContain(x.storeRecordId);
    }
    expect(text).not.toMatch(/https?:/);
  });
});

const CARDS = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'google_play', 'cards.json'),
    'utf8',
  ),
) as PlayCard[];
const PLAY = new URL('https://play.google.com/books?source=purchases');

/**
 * A fake Google Play Books page: a scrolling list that shows `window` cards at a time (and drops
 * the ones scrolled past, as long lists do), ending after the last card.
 */
function playPage(cards: PlayCard[], window = 2, extra: Partial<CardScanDeps> = {}) {
  let top = 0;
  let url = PLAY;
  const d: CardScanDeps = {
    page: PLAY,
    currentUrl: () => url,
    readCards: () => cards.slice(top, top + window),
    scroll: () => {
      top = Math.min(top + window, Math.max(0, cards.length - window));
      return { atBottom: top + window >= cards.length };
    },
    sleep: async () => {},
    now: () => new Date('2026-11-11T12:00:00Z'),
    signal: new AbortController().signal,
    ...extra,
  };
  return { d, goTo: (u: string) => (url = new URL(u)) };
}

describe('reading Google Play Books cards', () => {
  it('reads ebook cards as purchases with their volume ID and reader link, and asks about the rest', () => {
    const page = parsePlayCards(CARDS);
    expect(page.records.map((r) => [r.storeRecordId, r.acquisition.type])).toEqual([
      ['invEmberOrch01', 'purchase'],
      ['invTidewright02', 'purchase'],
      ['invLanterns003', 'purchase'],
      ['invQuietMach04', 'uncertain'],
      ['invOrchardLed05', 'purchase'],
    ]);
    expect(page.records[2]).toEqual({
      storeRecordId: 'invLanterns003',
      idKind: 'volume',
      title: 'Lanterns Over Harrowgate',
      unit: 'book',
      acquisition: { type: 'purchase', evidence: 'listed under Purchases; card type ebook' },
      readUrl: 'https://play.google.com/books/reader?id=invLanterns003',
      creators: [
        { name: 'Pell Inchcape', role: 'author' },
        { name: 'Wenna Holloway', role: 'author' },
      ],
    });
    expect(page.records[3]!.acquisition.evidence).toBe(
      'listed under Purchases; card type audiobook',
    );
    expect(page.records[4]!.creators).toBeUndefined();
    expect(Object.values(page.labelFor!)).toEqual([
      'ebook via /books/reader',
      'ebook via /books/reader',
      'ebook via /books/reader',
      'audiobook via /books/reader',
      'ebook via /books/reader',
    ]);
  });

  it('skips cards the page hasn’t filled in yet, and takes other Google book links as pages', () => {
    const page = parsePlayCards([
      { classes: ['card'], href: null, title: '', authors: [] },
      {
        classes: ['card', 'audiobook'],
        href: 'https://play.google.com/books/listen?id=invListen0006',
        title: 'Shared Shelf Stories',
        authors: ['Tobiah Renn'],
      },
    ]);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      storeRecordId: 'invListen0006',
      acquisition: { type: 'uncertain' },
      pageUrl: 'https://play.google.com/books/listen?id=invListen0006',
    });
    expect(page.records[0]!.readUrl).toBeUndefined();
    expect(page.labelFor).toEqual({ 'volume:invListen0006': 'audiobook via /books/listen' });
  });

  it('refuses cards that look different (the layout fingerprint)', () => {
    expect(() => parsePlayCards({})).toThrow(/list of book cards/);
    expect(() => parsePlayCards([{ ...CARDS[0], href: 'https://play.google.com/store' }])).toThrow(
      /without a Google book link \(the card had: authors, classes, href, title\)/,
    );
    expect(() => parsePlayCards([{ ...CARDS[0], href: 'https://example.com/x?id=1' }])).toThrow(
      /book link/,
    );
    expect(() => parsePlayCards([{ ...CARDS[0], title: ' ' }])).toThrow(/title/);
  });

  it('only runs on the purchases page, so uploads stay out', () => {
    expect(googlePlay.checkPage(PLAY).ok).toBe(true);
    const all = googlePlay.checkPage(new URL('https://play.google.com/books'));
    expect(!all.ok && all.message).toMatch(/source=purchases/);
    expect(googlePlay.checkPage(new URL('https://www.amazon.com/')).ok).toBe(false);
  });
});

describe('scanning a page of cards', () => {
  it('scrolls to the end, keeps every card seen, and ends complete', async () => {
    const r = await scanCards(googlePlay, playPage(CARDS).d);
    expect(r.envelope.records.map((x) => x.storeRecordId)).toEqual(
      CARDS.map((c) => new URL(c.href!).searchParams.get('id')),
    );
    expect(r.envelope).toMatchObject({
      service: 'google_play',
      adapterVersion: '2',
      completion: { status: 'complete', reason: 'finished' },
      counts: { seen: 5, included: 4, uncertain: 1 },
    });
    expect(r.stats.fingerprint).toBe('passed');
  });

  it('waits for cards that fill in as they scroll into view', async () => {
    // Cards below the first screen are empty until scrolled to.
    const filled = new Set<number>();
    let top = 0;
    const r = await scanCards(googlePlay, {
      ...playPage(CARDS).d,
      readCards: () =>
        CARDS.map((c, i) =>
          i < top + 2
            ? (filled.add(i), c)
            : { classes: ['card'], href: null, title: '', authors: [] },
        ),
      scroll: () => {
        top = Math.min(top + 2, CARDS.length);
        return { atBottom: top >= CARDS.length };
      },
    });
    expect(r.envelope.completion.status).toBe('complete');
    expect(r.envelope.records).toHaveLength(CARDS.length);
    expect(r.stats.labels).toEqual({
      'ebook via /books/reader': 4,
      'audiobook via /books/reader': 1,
    });
  });

  it('never reports an empty page as an empty library', async () => {
    const r = await scanCards(googlePlay, playPage([]).d);
    expect(r.envelope.completion).toMatchObject({ status: 'failed', reason: 'layout_changed' });
  });

  it('stops when the tab goes to a sign-in page', async () => {
    const p = playPage(CARDS);
    let steps = 0;
    p.d.sleep = async () => {
      if (++steps === 2) p.goTo('https://accounts.google.com/signin');
    };
    const r = await scanCards(googlePlay, p.d);
    expect(r.envelope.completion).toMatchObject({ status: 'partial', reason: 'signed_out' });
    expect(r.envelope.records.length).toBeGreaterThan(0);
  });

  it('stops as partial when cancelled, and at the safety limit', async () => {
    const ctrl = new AbortController();
    const cancelled = await scanCards(
      googlePlay,
      playPage(CARDS, 2, { signal: ctrl.signal, sleep: async () => ctrl.abort() }).d,
    );
    expect(cancelled.envelope.completion).toMatchObject({ status: 'partial', reason: 'cancelled' });
    const limited = await scanCards(
      googlePlay,
      playPage(CARDS, 1, { limits: { maxRequests: 2 } }).d,
    );
    expect(limited.envelope.completion).toMatchObject({
      status: 'partial',
      reason: 'limit_reached',
    });
  });
});

const KOBO_DIR = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'kobo');
const koboPage = (n: number) =>
  JSON.parse(fs.readFileSync(path.join(KOBO_DIR, `page-${n}.json`), 'utf8')) as {
    page: number;
    cards: unknown[];
  };
const KOBO = new URL('https://www.kobo.com/us/en/library/books');

/** A fake Kobo: answers each ?pageNumber=N with an HTML page the fake page side reads. */
function koboStore(pages: Record<string, () => { page: number; cards: unknown[] }>) {
  const asked: string[] = [];
  const html = (body = '<html></html>') =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  return {
    asked,
    deps: (extra: Partial<ScanDeps> = {}): ScanDeps => ({
      page: KOBO,
      fetch: async (url) => {
        asked.push(new URL(url).searchParams.get('pageNumber') ?? '');
        return html();
      },
      fromHtml: (_html, url) => {
        const n = new URL(url).searchParams.get('pageNumber')!;
        return pages[n] ? pages[n]!() : { page: Number(n), cards: [] };
      },
      sleep: async () => {},
      now: () => new Date('2026-11-11T12:00:00Z'),
      signal: new AbortController().signal,
      ...extra,
    }),
  };
}

describe('reading Kobo library pages', () => {
  it('keeps plain books as owned, sends preview and Kobo Plus cards to the owner, and reads status', () => {
    const one = parseKoboPage(koboPage(1));
    expect(one.next).toBe('2');
    expect(one.storeTotal).toBe(4);
    expect(one.records[0]).toEqual({
      storeRecordId: 'inv00000-0000-0000-0000-000000000001',
      idKind: 'product',
      title: 'The Ember Orchard',
      unit: 'book',
      acquisition: {
        type: 'purchase',
        evidence: 'in your Kobo Books library, with no preview or Kobo Plus mark',
      },
      creators: [{ name: 'Nell Varga', role: 'author' }],
      readUrl: 'https://readnow.kobo.com/inv00000-0000-0000-0000-000000000001',
      pageUrl: 'https://www.kobo.com/us/en/ebook/the-ember-orchard-invented',
      readingStatus: 'not_started',
    });
    expect(one.records[1]).toMatchObject({ readingStatus: 'finished' });
    expect(one.records[1]!.readUrl).toBeUndefined();
    const two = parseKoboPage(koboPage(2));
    expect(two.records.map((r) => [r.acquisition.type, r.acquisition.evidence])).toEqual([
      ['uncertain', 'in your Kobo Books library, marked book, preview'],
      ['uncertain', 'in your Kobo Books library, marked book, kobo-plus'],
    ]);
    expect(Object.values(two.labelFor!)).toEqual([
      'book+preview (not_started)',
      'book+kobo-plus (in_progress)',
    ]);
    expect(parseKoboPage(koboPage(3)).next).toBeNull();
  });

  it('refuses cards that look different, naming what they had', () => {
    expect(() => parseKoboPage({ cards: [] })).toThrow(/list of book cards/);
    expect(() =>
      parseKoboPage({
        page: 1,
        cards: [{ classes: ['item-wrapper', 'book'], title: 'Untracked', trackInfo: '{}' }],
      }),
    ).toThrow(/without a product ID \(the card had: classes, title\)/);
  });

  it('only runs on the Books library', () => {
    expect(kobo.checkPage(KOBO)).toEqual({ ok: true, region: 'kobo.com/us' });
    const lib = kobo.checkPage(new URL('https://www.kobo.com/us/en/library'));
    expect(!lib.ok && lib.message).toMatch(/library\/books/);
  });
});

describe('scanning Kobo', () => {
  it('reads page after page until an empty one, and notes the store’s own count', async () => {
    const s = koboStore({ '1': () => koboPage(1), '2': () => koboPage(2) });
    const r = await scan(kobo, s.deps());
    expect(s.asked).toEqual(['1', '2', '3']);
    expect(r.envelope).toMatchObject({
      service: 'kobo',
      region: 'kobo.com/us',
      completion: { status: 'complete', reason: 'finished' },
      counts: { seen: 4, included: 2, uncertain: 2 },
    });
    expect(r.stats.storeTotal).toBe(4);
    expect(report(kobo, r, 'x')).toContain("Found: 4 (the store's own count: 4)");
  });

  it('ends when a page past the end repeats the last one', async () => {
    const s = koboStore({
      '1': () => koboPage(1),
      '2': () => koboPage(2),
      '3': () => ({ ...koboPage(2), page: 3 }),
    });
    const r = await scan(kobo, s.deps());
    expect(s.asked).toEqual(['1', '2', '3']);
    expect(r.envelope.completion.status).toBe('complete');
    expect(r.envelope.records).toHaveLength(4);
  });

  it('stops at a sign-in page, and never reports an empty first page as an empty library', async () => {
    const s = koboStore({});
    const signedOut = await scan(kobo, {
      ...s.deps(),
      fetch: async () => {
        const res = new Response('<html>sign in</html>', {
          headers: { 'content-type': 'text/html' },
        });
        Object.defineProperty(res, 'url', { value: 'https://www.kobo.com/us/en/account/login' });
        return res;
      },
    });
    expect(signedOut.envelope.completion).toMatchObject({ status: 'failed', reason: 'signed_out' });
    const empty = await scan(kobo, koboStore({}).deps());
    expect(empty.envelope.completion).toMatchObject({ status: 'failed', reason: 'layout_changed' });
  });
});

const GC_DIR = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'globalcomix');
const gcPage = (n: number) => fs.readFileSync(path.join(GC_DIR, `page-${n}.json`), 'utf8');

describe('reading GlobalComix purchases', () => {
  it('reads each purchase: release, unit, series and number, ISBN, free unlocks, date, status and link', () => {
    const one = parseGlobalComixPage(JSON.parse(gcPage(1)));
    expect(one.next).toBe('2');
    expect(one.records[0]).toEqual({
      storeRecordId: '9200001',
      idKind: 'release',
      title: 'Starfall Academy, Volume 1',
      unit: 'volume',
      acquisition: { type: 'purchase', evidence: 'GlobalComix digital purchase' },
      series: 'Starfall Academy',
      seriesIndex: '1',
      isbn: '9780000000024',
      kind: 'comic',
      acquiredAt: { value: '2025-03-04', precision: 'day' },
      readingStatus: 'finished',
      progressPercent: 100,
      readUrl: 'https://globalcomix.com/read/inv-9200001/starfall-academy-volume-1',
    });
    expect(one.records[1]).toMatchObject({
      title: 'Night Over the Harbour',
      unit: 'issue',
      series: 'The Lantern Keepers',
      seriesIndex: '3',
      kind: 'manga',
      acquisition: { type: 'free_claim', evidence: 'GlobalComix digital purchase, at no charge' },
      readingStatus: 'in_progress',
      progressPercent: 40,
    });
    expect(one.records[1]!.isbn).toBeUndefined();
    expect(one.records[2]).toMatchObject({ unit: 'collection', series: 'Glass Harbor' });
    expect(one.records[2]!.seriesIndex).toBeUndefined();
    expect(one.records[2]!.readingStatus).toBeUndefined();
    expect(Object.values(one.labelFor!)).toEqual(['Volume', 'Issue (free)', 'Compendium']);
    expect(parseGlobalComixPage(JSON.parse(gcPage(2))).next).toBeNull();
  });

  it('refuses an answer that looks different', () => {
    expect(() => parseGlobalComixPage({ results: [] })).toThrow(/payload\.results/);
    expect(() => parseGlobalComixPage({ payload: { results: [{ id: 1 }] } })).toThrow(/release/);
  });

  it('only runs on the purchases page', () => {
    expect(globalcomix.checkPage(new URL('https://globalcomix.com/my-shelf/purchases')).ok).toBe(
      true,
    );
    const home = globalcomix.checkPage(new URL('https://globalcomix.com/'));
    expect(!home.ok && home.message).toMatch(/my-shelf\/purchases/);
  });

  it('scans page after page to the end and imports-ready counts add up', async () => {
    const asked: string[] = [];
    const r = await scan(
      globalcomix,
      deps(
        async (url) => {
          const u = new URL(url);
          expect(`${u.origin}${u.pathname}`).toBe(
            'https://api.globalcomix.com/v1/account/digital-purchases',
          );
          asked.push(u.searchParams.get('p')!);
          return json(gcPage(Number(u.searchParams.get('p'))));
        },
        { page: new URL('https://globalcomix.com/my-shelf/purchases') },
      ).d,
    );
    expect(asked).toEqual(['1', '2']);
    expect(r.envelope).toMatchObject({
      service: 'globalcomix',
      completion: { status: 'complete', reason: 'finished' },
      counts: { seen: 4, included: 4, uncertain: 0 },
    });
  });
});

describe('the console scripts', () => {
  it('are committed exactly as a fresh build makes them (run npm run build:collector)', async () => {
    for (const name of COLLECTOR_SCRIPTS)
      expect(fs.readFileSync(scriptPath(name), 'utf8')).toBe(await bundleCollector(name));
  });
});
