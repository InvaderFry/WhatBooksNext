import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { googlePlay } from '../../tools/store-collector/adapters/googlePlay.ts';
import { globalcomix } from '../../tools/store-collector/adapters/globalcomix.ts';
import { kindle } from '../../tools/store-collector/adapters/kindle.ts';
import { kobo } from '../../tools/store-collector/adapters/kobo.ts';
import { collectAnswers, scan, scanCards } from '../../tools/store-collector/core/scan.ts';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';
import { storeFile, type InventedRecord } from './testing/storeFile.ts';

/**
 * Importing a store collector's file (store purchases plan, "1b"): preview, import, repeat
 * imports, owner data winning, partial files, and books a later scan doesn't find. Invented books.
 */

const PORT = 4829;
const HOST = `localhost:${PORT}`;

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
};

beforeEach(async () => {
  drive = tempDir('wbn-store-purchases-');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
    fetcher: async () => new Response('{}', { status: 404 }),
  });
  writeFiles(drive, {
    'ember.epub': makeEpub({
      title: 'The Ember Orchard',
      creators: ['Nell Varga'],
      identifiers: ['9780000000017'],
      chapters: [900],
    }),
  });
  await api.post('/api/folders', { path: drive });
  await api.post('/api/scan', {});
  await made.scans.wait();
  // A Kindle book typed in earlier, without a link.
  await api.post('/api/store/items', {
    title: 'Tidewright',
    author: 'Osric Lane',
    store: 'kindle',
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

const BOOKS: InventedRecord[] = [
  {
    id: 'INVENTED0001',
    title: 'Ember Orchard',
    author: 'Nell Varga',
    isbn: '9780000000017',
    readUrl: 'https://read.amazon.com/?asin=INVENTED0001',
  },
  { id: 'INVENTED0002', title: 'Tidewright', author: 'Osric Lane' },
  {
    id: 'INVENTED0003',
    title: 'Lanterns Over Harrowgate',
    author: 'Pell Inchcape',
    readingStatus: 'finished',
    readUrl: 'https://read.amazon.com/?asin=INVENTED0003',
  },
  {
    id: 'INVENTED0004',
    title: 'Shared Shelf Stories',
    author: 'Tobiah Renn',
    acquisition: 'uncertain',
  },
];

const one = (sql: string, ...args: unknown[]) =>
  db
    .prepare(sql)
    .pluck()
    .get(...args);
const preview = async (text: string, extra: object = {}) =>
  (await api.post('/api/import/store-purchases/preview', { text, ...extra })).body;
const importFile = async (text: string, extra: object = {}) =>
  (await api.post('/api/import/store-purchases', { text, ...extra })).body;

describe('previewing a store purchases file', () => {
  it('shows each book’s outcome, uncertain ownership and the file’s own counts, changing nothing', async () => {
    const p = await preview(storeFile(BOOKS));
    expect(p).toMatchObject({
      service: 'kindle',
      label: 'Kindle',
      adapterVersion: '1',
      scope: 'default',
      scopeFromFile: false,
      completion: { status: 'complete', reason: 'finished' },
      counts: { seen: 6, included: 3, uncertain: 1, excluded: { sample: 1, subscription: 1 } },
      problems: [],
      shrink: null,
      notSeen: 0,
    });
    expect(p.rows.map((r: { key: string; outcome: string }) => [r.key, r.outcome])).toEqual([
      ['asin:INVENTED0001', 'isbn'],
      ['asin:INVENTED0002', 'possible'],
      ['asin:INVENTED0003', 'new'],
      ['asin:INVENTED0004', 'new'],
    ]);
    expect(p.rows[2].applies).toEqual(['a link to read it', 'progress finished']);
    expect(p.rows[3]).toMatchObject({ acquisition: 'uncertain' });
    expect(one('SELECT COUNT(*) FROM store_purchases')).toBe(0);
    expect(one('SELECT COUNT(*) FROM items')).toBe(2);
  });

  it('refuses files that aren’t a store file, or are from a newer collector, plainly', async () => {
    let r = await api.post('/api/import/store-purchases/preview', { text: 'title,author\nx,y' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/isn’t a whatBooksNext store file/);
    r = await api.post('/api/import/store-purchases/preview', {
      text: storeFile(BOOKS, { formatVersion: 2 }),
    });
    expect(r.body.error).toMatch(/newer collector/);
    r = await api.post('/api/import/store-purchases/preview', {
      text: storeFile(BOOKS, { service: 'apple_books' }),
    });
    expect(r.status).toBe(400);
  });

  it('turns a bad record into a problem line and reads the rest', async () => {
    const file = JSON.parse(storeFile(BOOKS));
    file.records[1].title = '';
    file.records[2].readUrl = 'https://example.com/INVENTED0003';
    const p = await preview(JSON.stringify(file));
    expect(p.rows).toHaveLength(3);
    expect(p.problems.join(' ')).toMatch(/Book 2: no title\. Skipped\./);
    expect(p.problems.join(' ')).toMatch(/Book 3: link left out\. .*not to Kindle/);
    // The counts no longer match the books that can be read: said, not hidden.
    expect(p.problems[0]).toMatch(/The file says 3 books/);
  });
});

describe('importing a store purchases file', () => {
  it('adds new books, attaches by ISBN, and leaves uncertain ownership out until ticked', async () => {
    const r = await importFile(storeFile(BOOKS));
    // An unticked possible match is a different book (as with the store CSV); the uncertain one
    // waits for a tick.
    expect(r).toEqual({ added: 2, attached: 1, already: 0, skipped: 1, links: 2, notSeen: 0 });
    const lanterns = one("SELECT id FROM items WHERE title = 'Lanterns Over Harrowgate'") as string;
    expect((await api.get(`/api/items/${lanterns}`)).body).toMatchObject({
      user: { progress: 'finished' },
      availability: {
        state: 'store',
        storeLinks: [{ store: 'kindle', url: 'https://read.amazon.com/?asin=INVENTED0003' }],
      },
    });
    expect(
      db
        .prepare(
          'SELECT service, account_scope, id_kind, acquisition FROM store_purchases ORDER BY store_record_id',
        )
        .all(),
    ).toEqual(
      Array(3).fill({
        service: 'kindle',
        account_scope: 'default',
        id_kind: 'asin',
        acquisition: 'purchase',
      }),
    );
    expect(one("SELECT COUNT(*) FROM import_keys WHERE source = 'store_json:kindle'")).toBe(3);
    // The run log keeps counts, never titles.
    const run = db.prepare('SELECT * FROM store_import_runs').get() as Record<string, string>;
    expect(run).toMatchObject({ service: 'kindle', completion: 'complete', adapter_version: '1' });
    expect(JSON.stringify(run)).not.toMatch(/Lanterns|Ember|INVENTED/);
  });

  it('attaches a ticked match and imports a ticked uncertain book', async () => {
    const r = await importFile(storeFile(BOOKS), {
      attach: ['asin:INVENTED0002'],
      uncertain: ['asin:INVENTED0004'],
    });
    expect(r).toMatchObject({ added: 2, attached: 2, skipped: 0 });
    expect(one("SELECT COUNT(*) FROM items WHERE title = 'Tidewright'")).toBe(1);
    expect(
      one("SELECT acquisition FROM store_purchases WHERE store_record_id = 'INVENTED0004'"),
    ).toBe('uncertain');
  });

  it('adds nothing twice on a repeat import, and adds books bought since', async () => {
    await importFile(storeFile(BOOKS), { attach: ['asin:INVENTED0002'] });
    const items = one('SELECT COUNT(*) FROM items');
    const again = await preview(storeFile(BOOKS));
    expect(again.rows.filter((r: { outcome: string }) => r.outcome === 'already')).toHaveLength(3);
    expect(await importFile(storeFile(BOOKS))).toMatchObject({ added: 0, attached: 0, already: 3 });
    expect(one('SELECT COUNT(*) FROM items')).toBe(items);
    const more = [...BOOKS, { id: 'INVENTED0009', title: 'A New Purchase', author: 'Ivo Brask' }];
    expect(await importFile(storeFile(more))).toMatchObject({ added: 1, already: 3 });
  });

  it('never overwrites the owner’s progress or a link they changed', async () => {
    await importFile(
      storeFile(BOOKS.slice(2, 3), {
        completion: { status: 'partial', reason: 'cancelled', text: 'x' },
      }),
    );
    const id = one("SELECT id FROM items WHERE title = 'Lanterns Over Harrowgate'") as string;
    await api.patch(`/api/items/${id}`, { progress: 'dnf' });
    const p = await preview(storeFile(BOOKS.slice(2, 3)), {});
    expect(p.rows[0].outcome).toBe('already');
    expect((await api.get(`/api/items/${id}`)).body.user.progress).toBe('dnf');
  });

  it('labels a partial file, imports it, and never marks books as not seen from it', async () => {
    await importFile(storeFile(BOOKS.slice(0, 3)), { attach: ['asin:INVENTED0002'] });
    const partial = storeFile(BOOKS.slice(0, 1), {
      completion: { status: 'partial', reason: 'blocked', text: 'The store refused the request.' },
    });
    const p = await preview(partial);
    expect(p.completion.status).toBe('partial');
    expect(p.notSeen).toBe(0);
    expect((await importFile(partial)).notSeen).toBe(0);
    expect(
      (await api.get('/api/review')).body.rows.filter(
        (r: { kind: string }) => r.kind === 'store_not_seen',
      ),
    ).toEqual([]);
  });

  it('sends books a later complete scan didn’t find to Needs review, with Keep and Remove', async () => {
    await importFile(storeFile(BOOKS.slice(0, 3)), { attach: ['asin:INVENTED0002'] });
    const later = storeFile(BOOKS.slice(0, 2));
    // Three books before, two now: a third fewer, so the warning comes first.
    const p = await preview(later);
    expect(p).toMatchObject({ notSeen: 1, shrink: { before: 3, now: 2 } });
    expect((await importFile(later)).notSeen).toBe(0);
    // The same short file again, unconfirmed: still warned, still nothing sent to review.
    expect(await preview(later)).toMatchObject({ shrink: { before: 3, now: 2 } });
    expect((await importFile(later)).notSeen).toBe(0);
    expect((await importFile(later, { confirmShrink: true })).notSeen).toBe(1);

    const rows = (await api.get('/api/review')).body.rows.filter(
      (r: { kind: string }) => r.kind === 'store_not_seen',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 3,
      why: 'Not seen in your latest Kindle scan: returned, refunded or removed?',
      items: [{ title: 'Lanterns Over Harrowgate' }],
    });
    const purchase = rows[0].id.replace('notseen:', '');
    expect(
      (await api.post(`/api/store-purchases/${purchase}/not-seen`, { action: 'keep' })).status,
    ).toBe(200);
    expect(
      (await api.get('/api/review')).body.rows.filter(
        (r: { kind: string }) => r.kind === 'store_not_seen',
      ),
    ).toEqual([]);
    // Missed again by a later complete scan: still kept, not asked again.
    await importFile(later, { confirmShrink: true });
    expect(one('SELECT not_seen_kept FROM store_purchases WHERE id = ?', purchase)).toBe(1);

    // Found again, then missed again: asked again; Remove takes the store copy away for good.
    await importFile(storeFile(BOOKS.slice(0, 3)));
    expect(one('SELECT not_seen_kept FROM store_purchases WHERE id = ?', purchase)).toBe(0);
    await importFile(later, { confirmShrink: true });
    await api.post(`/api/store-purchases/${purchase}/not-seen`, { action: 'remove' });
    const id = one("SELECT id FROM items WHERE title = 'Lanterns Over Harrowgate'") as string;
    expect(one("SELECT COUNT(*) FROM locations WHERE item_id = ? AND kind = 'store'", id)).toBe(0);
    await importFile(storeFile(BOOKS.slice(0, 3)));
    expect(one("SELECT COUNT(*) FROM locations WHERE item_id = ? AND kind = 'store'", id)).toBe(0);
  });

  it('keeps a second account’s books apart when the owner names it', async () => {
    await importFile(storeFile(BOOKS.slice(2, 3)));
    const p = await preview(storeFile(BOOKS.slice(2, 3)), { accountName: 'Work account' });
    expect(p.scope).toBe('named:work-account');
    expect(p.rows[0].outcome).not.toBe('already');
  });

  it('shows the last import per store in Diagnostics, without titles', async () => {
    await importFile(storeFile(BOOKS));
    const d = (await api.get('/api/diagnostics')).body;
    expect(d.storeImports).toEqual([
      expect.objectContaining({ service: 'kindle', adapterVersion: '1', completion: 'complete' }),
    ]);
    expect(JSON.stringify(d.storeImports)).not.toMatch(/Lanterns|INVENTED/);
  });
});

describe('the collectors in the app', () => {
  it('lists each store’s collector honestly and hands over the Kindle script', async () => {
    const list = (await api.get('/api/store-collectors')).body;
    expect(list).toEqual([
      {
        service: 'kindle',
        state: 'checked',
        checkedOn: '2026-11-11',
        page: 'https://read.amazon.com/kindle-library',
      },
      {
        service: 'google_play',
        state: 'checked',
        checkedOn: '2026-11-11',
        page: 'https://play.google.com/books?source=purchases',
      },
      {
        service: 'kobo',
        state: 'checked',
        checkedOn: '2026-11-11',
        page: 'https://www.kobo.com/us/en/library/books',
      },
      {
        service: 'globalcomix',
        state: 'checked',
        checkedOn: '2026-11-11',
        page: 'https://globalcomix.com',
      },
    ]);
    const s = await api.get('/api/store-collectors/kindle/script');
    expect(s.body.script).toContain('kindle-library/search');
    expect((await api.get('/api/store-collectors/kobo/script')).body.script).toContain(
      'library/books',
    );
    expect((await api.get('/api/store-collectors/globalcomix/script')).body.script).toContain(
      'digital-purchases',
    );
    expect((await api.get('/api/store-collectors/apple_books/script')).status).toBe(404);
    const mark = (await api.get('/api/store-collectors/kobo/bookmarklet')).body;
    expect(mark.href.startsWith('javascript:')).toBe(true);
    expect(mark.version).toBe('1');
    expect((await api.get('/api/store-collectors/apple_books/bookmarklet')).status).toBe(404);
    // The look-around script for stores with no collector yet.
    expect((await api.get('/api/store-collectors/probe/script')).body.script).toContain(
      'look-around report',
    );
  });

  it('imports exactly what a collector scan produced (invented store answers)', async () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'kindle');
    const pages: Record<string, string> = { '0': 'page-1', '4': 'page-2', '7': 'page-end' };
    const result = await scan(kindle, {
      page: new URL('https://read.amazon.com/kindle-library'),
      fetch: async (url) =>
        new Response(
          fs.readFileSync(
            path.join(dir, `${pages[new URL(url).searchParams.get('paginationToken')!]}.json`),
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
      sleep: async () => {},
      now: () => new Date('2026-11-11T12:00:00Z'),
      signal: new AbortController().signal,
    });
    const text = JSON.stringify(result.envelope);
    const p = await preview(text);
    expect(p.problems).toEqual([]);
    expect(p.counts).toMatchObject({ seen: 7, included: 3, uncertain: 1 });
    expect(await importFile(text, { attach: ['asin:INVENTED0005'] })).toMatchObject({
      added: 2,
      attached: 1,
      skipped: 1,
    });
  });

  it('imports what the Google Play Books collector read, as Google Play store copies with links', async () => {
    const cards = JSON.parse(
      fs.readFileSync(
        path.join(
          import.meta.dirname,
          '..',
          '..',
          'fixtures',
          'stores',
          'google_play',
          'cards.json',
        ),
        'utf8',
      ),
    );
    const result = await scanCards(googlePlay, {
      page: new URL('https://play.google.com/books?source=purchases'),
      currentUrl: () => new URL('https://play.google.com/books?source=purchases'),
      readCards: () => cards,
      scroll: () => ({ atBottom: true }),
      sleep: async () => {},
      now: () => new Date('2026-11-11T12:00:00Z'),
      signal: new AbortController().signal,
    });
    const text = JSON.stringify(result.envelope);
    const p = await preview(text);
    expect(p).toMatchObject({ service: 'google_play', label: 'Google Play Books', problems: [] });
    expect(p.rows.find((r: { key: string }) => r.key === 'volume:invQuietMach04').acquisition).toBe(
      'uncertain',
    );
    const r = await importFile(text, {
      attach: ['volume:invEmberOrch01', 'volume:invTidewright02'],
    });
    expect(r).toMatchObject({ added: 2, attached: 2, skipped: 1, links: 4 });
    const ledger = one("SELECT id FROM items WHERE title = 'The Orchard Ledger'") as string;
    expect((await api.get(`/api/items/${ledger}`)).body.availability.storeLinks).toEqual([
      {
        store: 'google_play',
        url: 'https://play.google.com/books/reader?id=invOrchardLed05',
        kind: 'read',
        host: 'play.google.com',
      },
    ]);
  });

  it('spots the same book twice in one file, and joins them when ticked', async () => {
    const twice = storeFile([
      { id: 'INVENTED0301', title: 'Faust Revisited', author: 'Ivo Brask' },
      { id: 'INVENTED0302', title: 'Faust Revisited', author: 'Ivo Brask' },
    ]);
    const p = await preview(twice);
    expect(
      p.rows.map((r: { outcome: string; sameInFile: string | null }) => [r.outcome, r.sameInFile]),
    ).toEqual([
      ['new', null],
      ['possible', 'asin:INVENTED0301'],
    ]);
    expect(p.rows[1].itemTitle).toBe('Faust Revisited');
    expect(await importFile(twice, { attach: ['asin:INVENTED0302'] })).toMatchObject({
      added: 1,
      attached: 1,
    });
    expect(one("SELECT COUNT(*) FROM items WHERE title = 'Faust Revisited'")).toBe(1);
    expect(one('SELECT COUNT(DISTINCT item_id) FROM store_purchases')).toBe(1);
    expect(one('SELECT COUNT(*) FROM store_purchases')).toBe(2);
    // Importing again finds both as already imported.
    expect(await importFile(twice)).toMatchObject({ already: 2, added: 0 });
  });

  it('keeps them as two books when not ticked', async () => {
    const twice = storeFile([
      { id: 'INVENTED0301', title: 'Faust Revisited', author: 'Ivo Brask' },
      { id: 'INVENTED0302', title: 'Faust Revisited', author: 'Ivo Brask' },
    ]);
    expect(await importFile(twice)).toMatchObject({ added: 2 });
    expect(one("SELECT COUNT(*) FROM items WHERE title = 'Faust Revisited'")).toBe(2);
  });

  it('imports what the Kobo collector read: links, reading status, and preview cards to tick', async () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'kobo');
    const result = await scan(kobo, {
      page: new URL('https://www.kobo.com/us/en/library/books'),
      fetch: async () =>
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      fromHtml: (_h, url) => {
        const n = new URL(url).searchParams.get('pageNumber')!;
        const f = path.join(dir, `page-${n}.json`);
        return fs.existsSync(f)
          ? JSON.parse(fs.readFileSync(f, 'utf8'))
          : { page: Number(n), cards: [] };
      },
      sleep: async () => {},
      now: () => new Date('2026-11-11T12:00:00Z'),
      signal: new AbortController().signal,
    });
    const text = JSON.stringify(result.envelope);
    const p = await preview(text);
    expect(p).toMatchObject({ service: 'kobo', label: 'Kobo', problems: [] });
    expect(
      p.rows.filter((r: { acquisition: string }) => r.acquisition === 'uncertain'),
    ).toHaveLength(2);
    // Tidewright (typed in earlier as a Kindle book) is offered as the same book; not ticked here.
    expect(await importFile(text)).toMatchObject({ added: 2, skipped: 2 });
    const tide = db
      .prepare(
        "SELECT i.id FROM items i JOIN locations l ON l.item_id = i.id WHERE i.title = 'Tidewright' AND l.store = 'kobo'",
      )
      .pluck()
      .get() as string;
    const item = (await api.get(`/api/items/${tide}`)).body;
    expect(item.user.progress).toBe('finished');
    const ember = db
      .prepare(
        "SELECT i.id FROM items i JOIN locations l ON l.item_id = i.id WHERE l.store = 'kobo' AND i.title = 'The Ember Orchard'",
      )
      .pluck()
      .get() as string;
    expect((await api.get(`/api/items/${ember}`)).body.availability.storeLinks).toEqual([
      {
        store: 'kobo',
        url: 'https://readnow.kobo.com/inv00000-0000-0000-0000-000000000001',
        kind: 'read',
        host: 'readnow.kobo.com',
      },
    ]);
  });

  it('imports what the GlobalComix collector read: comics with series, numbers and dates', async () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'fixtures', 'stores', 'globalcomix');
    const page = (n: number) =>
      JSON.parse(fs.readFileSync(path.join(dir, `page-${n}.json`), 'utf8'));
    const result = collectAnswers(
      globalcomix,
      [page(1), page(2)],
      { ended: 'whole_list', region: 'globalcomix.com' },
      new Date('2026-11-11T12:00:00Z'),
    );
    const text = JSON.stringify(result.envelope);
    const p = await preview(text);
    expect(p).toMatchObject({ service: 'globalcomix', problems: [], counts: { included: 4 } });
    expect(await importFile(text)).toMatchObject({ added: 4, links: 4 });
    expect(
      db
        .prepare(
          "SELECT unit, acquisition, acquired_at, acquired_precision FROM store_purchases WHERE store_record_id = '9200002'",
        )
        .get(),
    ).toEqual({
      unit: 'issue',
      acquisition: 'free_claim',
      acquired_at: '2025-06-12',
      acquired_precision: 'day',
    });
    const vol = one("SELECT id FROM items WHERE title = 'Starfall Academy, Volume 1'") as string;
    const item = (await api.get(`/api/items/${vol}`)).body;
    expect(item.user.progress).toBe('finished');
    expect(item.availability.storeLinks[0]).toMatchObject({ store: 'globalcomix', kind: 'read' });
    expect(one('SELECT series_hint FROM items WHERE id = ?', vol)).toBe('Starfall Academy');
  });

  it('filters the Library by store, with each store’s count, and finds books in no store', async () => {
    await importFile(storeFile(BOOKS.slice(2, 3)));
    const all = (await api.get('/api/items')).body;
    // The epub is in no store; Tidewright was typed in as Kindle; Lanterns came from the file.
    expect(all.storeCounts).toEqual({ none: 1, kindle: 2 });
    const kindle = (await api.get('/api/items?store=kindle')).body;
    expect(kindle.items.map((i: { title: string }) => i.title).sort()).toEqual([
      'Lanterns Over Harrowgate',
      'Tidewright',
    ]);
    const none = (await api.get('/api/items?store=none')).body;
    expect(none.items.map((i: { title: string }) => i.title)).toEqual(['The Ember Orchard']);
    expect((await api.get('/api/items?store=kobo')).body.total).toBe(0);
    expect(kindle.items[0].stores).toEqual(['kindle']);
  });
});
