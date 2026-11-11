import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindle } from '../../tools/store-collector/adapters/kindle.ts';
import { scan } from '../../tools/store-collector/core/scan.ts';
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
      { service: 'google_play', state: 'not_built', checkedOn: null, page: null },
      { service: 'kobo', state: 'not_built', checkedOn: null, page: null },
      { service: 'globalcomix', state: 'not_built', checkedOn: null, page: null },
    ]);
    const s = await api.get('/api/store-collectors/kindle/script');
    expect(s.body.script).toContain('kindle-library/search');
    expect((await api.get('/api/store-collectors/kobo/script')).status).toBe(404);
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
});
