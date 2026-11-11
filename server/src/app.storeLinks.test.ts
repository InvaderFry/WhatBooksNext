import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { checkStoreLink, type Store } from './lib/store.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/**
 * Store links (docs/plans/get-store-purchase-imports.md): a store copy can carry a link to read
 * it there. Every ID and link here is invented and not in the store's own form, so none can
 * point to a real book.
 */

const PORT = 4823;
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
  drive = tempDir('wbn-store-links-');
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
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

const refused = (store: Store, url: string) => {
  try {
    checkStoreLink(store, url);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('which links a store copy may carry', () => {
  it('accepts each store’s own https sites, and says whether it opens the reader or a page', () => {
    expect(checkStoreLink('kindle', 'https://read.amazon.com/?asin=INVENTED-1')).toEqual({
      url: 'https://read.amazon.com/?asin=INVENTED-1',
      kind: 'read',
    });
    expect(checkStoreLink('kindle', 'https://read.amazon.co.uk/?asin=INVENTED-1').kind).toBe(
      'read',
    );
    expect(checkStoreLink('kindle', 'https://www.amazon.de/dp/INVENTED-1').kind).toBe('page');
    expect(
      checkStoreLink('google_play', 'https://play.google.com/books/reader?id=invented-vol').kind,
    ).toBe('read');
    expect(
      checkStoreLink('google_play', 'https://play.google.com/store/books/details?id=invented-vol')
        .kind,
    ).toBe('page');
    expect(checkStoreLink('kobo', 'https://www.kobo.com/ww/en/ebook/invented-book').kind).toBe(
      'page',
    );
    expect(checkStoreLink('kobo', 'https://readnow.kobo.com/inv-book-0001').kind).toBe('read');
    expect(checkStoreLink('globalcomix', 'https://globalcomix.com/c/invented-comic').kind).toBe(
      'page',
    );
  });

  it('refuses http, javascript:, other sites and look-alike hosts, with a plain message', () => {
    expect(refused('kindle', 'http://read.amazon.com/?asin=INVENTED-1')).toMatch(/https/);
    expect(refused('kindle', 'javascript:alert(1)')).toMatch(/https/);
    expect(refused('kindle', 'not a link')).toMatch(/isn’t a web link/);
    expect(refused('kindle', 'https://example.com/dp/INVENTED-1')).toMatch(
      /goes to example\.com, not to Kindle/,
    );
    expect(refused('kindle', 'https://read.amazon.com.example.net/')).toMatch(/not to Kindle/);
    expect(refused('kobo', 'https://read.amazon.com/?asin=INVENTED-1')).toMatch(/not to Kobo/);
    expect(refused('kindle', 'https://someone:secret@read.amazon.com/')).toMatch(/extra parts/);
    expect(refused('kindle', 'https://read.amazon.com:8443/')).toMatch(/extra parts/);
    // Play also sells apps: only its book links are accepted.
    expect(refused('google_play', 'https://play.google.com/store/apps/details?id=x')).toMatch(
      /isn’t for a book/,
    );
  });

  it('takes no link for Apple Books, and any real https site for another app', () => {
    expect(refused('apple_books', 'https://books.apple.com/book/id0')).toMatch(/no web reader/);
    expect(checkStoreLink('other', 'https://reader.invented.example/b/1')).toEqual({
      url: 'https://reader.invented.example/b/1',
      kind: 'page',
    });
    expect(refused('other', 'https://localhost/x')).toMatch(/doesn’t go to a website/);
    expect(refused('other', 'https://192.168.1.2/x')).toMatch(/doesn’t go to a website/);
    expect(refused('other', 'http://reader.invented.example/b/1')).toMatch(/https/);
  });
});

describe('store links in the app', () => {
  it('saves a link typed in manual entry as the owner’s, and shows it on the book', async () => {
    const r = await api.post('/api/store/items', {
      title: 'Lanterns Over Harrowgate',
      store: 'kindle',
      url: 'https://read.amazon.com/?asin=INVENTED-1',
    });
    expect(r.status).toBe(200);
    const [loc] = (await api.get(`/api/items/${r.body.itemId}/locations`)).body;
    expect(loc).toMatchObject({
      store: 'kindle',
      url: 'https://read.amazon.com/?asin=INVENTED-1',
      urlKind: 'read',
      urlHost: 'read.amazon.com',
      urlByOwner: true,
    });
    const item = (await api.get(`/api/items/${r.body.itemId}`)).body;
    expect(item.availability.storeLinks).toEqual([
      {
        store: 'kindle',
        url: 'https://read.amazon.com/?asin=INVENTED-1',
        kind: 'read',
        host: 'read.amazon.com',
      },
    ]);
    // The What next card carries it too.
    const card = (await api.get('/api/next')).body.cards.find(
      (c: { id: string }) => c.id === r.body.itemId,
    );
    expect(card.availability.storeLinks).toHaveLength(1);
  });

  it('refuses a bad link in manual entry and saves nothing', async () => {
    const r = await api.post('/api/store/items', {
      title: 'Lanterns Over Harrowgate',
      store: 'kindle',
      url: 'https://example.com/INVENTED-1',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not to Kindle/);
    expect(db.prepare('SELECT COUNT(*) FROM locations').pluck().get()).toBe(0);
  });

  it('adds, changes and removes a link on a store copy, and refuses one for another site', async () => {
    const { itemId } = (await api.post('/api/store/items', { title: 'Tidewright', store: 'kobo' }))
      .body;
    const [loc] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect(loc.url).toBeNull();
    expect(
      (await api.patch(`/api/locations/${loc.id}`, { url: 'https://kobo.com/ww/en/ebook/inv-1' }))
        .status,
    ).toBe(200);
    expect(
      (await api.patch(`/api/locations/${loc.id}`, { url: 'https://evil.example/kobo' })).status,
    ).toBe(400);
    let [now] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect(now).toMatchObject({ url: 'https://kobo.com/ww/en/ebook/inv-1', urlByOwner: true });
    await api.patch(`/api/locations/${loc.id}`, { url: 'https://www.kobo.com/ww/en/ebook/inv-2' });
    [now] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect(now.url).toBe('https://www.kobo.com/ww/en/ebook/inv-2');
    await api.patch(`/api/locations/${loc.id}`, { url: null });
    [now] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect(now).toMatchObject({ url: null, urlByOwner: true, readable: false });
    expect((await api.get(`/api/items/${itemId}`)).body.availability.storeLinks).toEqual([]);
  });

  it('keeps "I can read it there now" working on its own', async () => {
    const { itemId } = (await api.post('/api/store/items', { title: 'Tidewright', store: 'kobo' }))
      .body;
    const [loc] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect((await api.patch(`/api/locations/${loc.id}`, { readable: true })).status).toBe(200);
    expect((await api.patch(`/api/locations/${loc.id}`, {})).status).toBe(400);
    const [now] = (await api.get(`/api/items/${itemId}/locations`)).body;
    expect(now).toMatchObject({ readable: true, url: null, urlByOwner: false });
  });
});

describe('the store CSV url column', () => {
  const link = 'https://read.amazon.com/?asin=INVENTED-7';
  const csv = (url: string) =>
    `title,author,store,url\nLanterns Over Harrowgate,Pell Inchcape,Kindle,${url}\n`;

  it('imports a link with a new book, as an import (not the owner’s)', async () => {
    const preview = (await api.post('/api/import/csv/preview', { text: csv(link) })).body;
    expect(preview.rows[0].applies).toContain('a link to read it');
    const r = (await api.post('/api/import/csv', { text: csv(link) })).body;
    expect(r).toMatchObject({ added: 1, links: 1 });
    expect(db.prepare('SELECT url, url_kind, url_by_owner FROM locations').get() as object).toEqual(
      { url: link, url_kind: 'read', url_by_owner: 0 },
    );
  });

  it('leaves a refused link out with a plain problem line, and still imports the book', async () => {
    const text = csv('https://example.com/INVENTED-7');
    const preview = (await api.post('/api/import/csv/preview', { text })).body;
    expect(preview.problems.join(' ')).toMatch(/Line 2: link left out\. .*not to Kindle/);
    expect((await api.post('/api/import/csv', { text })).body).toMatchObject({
      added: 1,
      links: 0,
    });
    expect(db.prepare('SELECT url FROM locations').pluck().get()).toBeNull();
  });

  it('adds a missing link on a repeat import, to a book entered earlier without one', async () => {
    await api.post('/api/import/csv', {
      text: 'title,author,store\nLanterns Over Harrowgate,Pell Inchcape,Kindle\n',
    });
    const preview = (await api.post('/api/import/csv/preview', { text: csv(link) })).body;
    expect(preview.rows[0]).toMatchObject({ outcome: 'already', applies: ['a link to read it'] });
    expect((await api.post('/api/import/csv', { text: csv(link) })).body).toMatchObject({
      already: 1,
      links: 1,
    });
    expect(db.prepare('SELECT url FROM locations').pluck().get()).toBe(link);
    // Once there, the same file changes nothing.
    expect((await api.post('/api/import/csv', { text: csv(link) })).body).toMatchObject({
      already: 1,
      links: 0,
    });
  });

  it('adds a link to an existing book matched by ISBN', async () => {
    const text = `title,store,isbn,url\nEmber Orchard,Kindle,9780000000017,${link}\n`;
    expect((await api.post('/api/import/csv', { text })).body).toMatchObject({
      attached: 1,
      links: 1,
    });
    const ember = db
      .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id')
      .pluck()
      .get() as string;
    const item = (await api.get(`/api/items/${ember}`)).body;
    // The file is here, so the state stays "present"; the store link is offered as well.
    expect(item.availability.state).toBe('present');
    expect(item.availability.storeLinks).toHaveLength(1);
  });

  it('never replaces a link the owner changed, and a removed link stays removed', async () => {
    await api.post('/api/import/csv', { text: csv(link) });
    const [loc] = db.prepare('SELECT id FROM locations').pluck().all() as string[];
    const mine = 'https://www.amazon.com/dp/INVENTED-MINE';
    await api.patch(`/api/locations/${loc}`, { url: mine });
    const preview = (await api.post('/api/import/csv/preview', { text: csv(link) })).body;
    expect(preview.rows[0].kept).toContain('link: yours is kept');
    await api.post('/api/import/csv', { text: csv(link) });
    expect(db.prepare('SELECT url FROM locations').pluck().get()).toBe(mine);

    await api.patch(`/api/locations/${loc}`, { url: null });
    expect((await api.post('/api/import/csv', { text: csv(link) })).body.links).toBe(0);
    expect(db.prepare('SELECT url FROM locations').pluck().get()).toBeNull();
  });

  it('imports a file without the url column exactly as before', async () => {
    const r = await api.post('/api/import/csv/preview', {
      text: 'title,store\nLanterns Over Harrowgate,Kindle\n',
    });
    expect(r.body.problems).toEqual([]);
    expect(r.body.rows[0].applies).toEqual([]);
  });

  it('writes links in the CSV export’s store_links column', async () => {
    await api.post('/api/import/csv', { text: csv(link) });
    const text = (await api.get('/api/export/csv')).text.replace(/^\uFEFF/, '');
    const lines = text.split('\r\n');
    const header = lines[1]!.split(',');
    const col = header.indexOf('store_links');
    expect(col).toBe(header.indexOf('stores') + 1);
    const row = lines.find((l) => l.includes('Lanterns'))!;
    expect(row.split(',')[col]).toBe(link);
  });
});
