import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleCollector, COLLECTOR_SCRIPTS, scriptPath } from '../../scripts/buildCollector.ts';
import { kindle, parseKindlePage } from '../../tools/store-collector/adapters/kindle.ts';
import { report } from '../../tools/store-collector/core/report.ts';
import { scan, type ScanDeps } from '../../tools/store-collector/core/scan.ts';

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

describe('the console scripts', () => {
  it('are committed exactly as a fresh build makes them (run npm run build:collector)', async () => {
    for (const name of COLLECTOR_SCRIPTS)
      expect(fs.readFileSync(scriptPath(name), 'utf8')).toBe(await bundleCollector(name));
  });
});
