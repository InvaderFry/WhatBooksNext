import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { createStoreItem } from './lib/store.ts';
import { queryLibrary, type ItemSummary } from './lib/library.ts';
import { pathRelation } from './scan/folders.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/**
 * Library folders that overlap (review fixes 2026-11, Stage 1): a folder inside another would
 * list every file twice. Folder names are invented.
 */

const PORT = 4818;
const HOST = `localhost:${PORT}`;

let db: DB;
let root: string;
let dataDir: string;
let made: ReturnType<typeof createApp>;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
};

const dir = (...parts: string[]) => {
  const p = path.join(root, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

beforeEach(async () => {
  root = tempDir('wbn-folders-');
  dataDir = dir('AppData');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive: root }),
    port: PORT,
    dataDir,
    snapshotDir: null,
    autoLookups: false,
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('adding a library folder', () => {
  it('refuses a folder inside a library folder, and says which one', async () => {
    const books = dir('Books');
    expect((await api.post('/api/folders', { path: books })).status).toBe(200);
    const r = await api.post('/api/folders', { path: dir('Books', 'Comics') });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(books);
    expect(r.body.error).toMatch(/inside/);
  });

  it('refuses a folder that contains a library folder, and says which one', async () => {
    const comics = dir('Books', 'Comics');
    expect((await api.post('/api/folders', { path: comics })).status).toBe(200);
    const r = await api.post('/api/folders', { path: dir('Books') });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(comics);
  });

  it('accepts a folder whose name only starts like a library folder’s', async () => {
    expect((await api.post('/api/folders', { path: dir('Books') })).status).toBe(200);
    expect((await api.post('/api/folders', { path: dir('Books2') })).status).toBe(200);
  });

  it('refuses a folder inside a library folder typed in a different case', async () => {
    expect((await api.post('/api/folders', { path: dir('Books') })).status).toBe(200);
    // On Windows this is the same folder; elsewhere the test makes it exist.
    const r = await api.post('/api/folders', { path: dir('BOOKS', 'Comics') });
    expect(r.status).toBe(409);
  });

  it('refuses the app’s data folder in a different case', async () => {
    const r = await api.post('/api/folders', { path: dir('APPDATA') });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/data folder/);
  });

  it('refuses a folder that holds the app’s data folder', async () => {
    const r = await api.post('/api/folders', { path: root });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/data folder/);
  });
});

describe('comparing folder paths', () => {
  it('compares without regard to case, on whole path segments', () => {
    const base = path.resolve('/lib');
    const p = (...s: string[]) => path.join(base, ...s);
    expect(pathRelation(p('Books'), p('books'))).toBe('same');
    expect(pathRelation(p('Books', 'Comics'), p('BOOKS'))).toBe('inside');
    expect(pathRelation(p('books'), p('Books', 'Comics'))).toBe('contains');
    expect(pathRelation(p('Books2'), p('Books'))).toBeNull();
    expect(pathRelation(p('Books'), p('Books2'))).toBeNull();
    expect(pathRelation(p('Books', 'Comics') + path.sep, p('Books'))).toBe('inside');
  });
});

describe('reconnecting a library folder', () => {
  it('refuses a relative path', async () => {
    const id = (await api.post('/api/folders', { path: dir('Books') })).body.id as string;
    const r = await api.post(`/api/folders/${id}/reconnect`, { path: 'Books' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/full path/);
  });

  it('refuses the path of another library folder, or one inside it', async () => {
    const books = dir('Books');
    await api.post('/api/folders', { path: books });
    const id = (await api.post('/api/folders', { path: dir('Other') })).body.id as string;
    expect((await api.post(`/api/folders/${id}/reconnect`, { path: books })).status).toBe(409);
    expect(
      (await api.post(`/api/folders/${id}/reconnect`, { path: dir('Books', 'Comics') })).status,
    ).toBe(409);
    expect((await api.post(`/api/folders/${id}/reconnect`, { path: dataDir })).status).toBe(400);
  });

  it('still moves a folder, and its files keep their ids', async () => {
    const books = dir('Books');
    writeFiles(books, { 'the-lantern-road.epub': 10 });
    const id = (await api.post('/api/folders', { path: books })).body.id as string;
    await api.post('/api/scan', {});
    await made.scans.wait();
    const before = db.prepare('SELECT id FROM files').pluck().all();
    const moved = dir('Moved');
    fs.cpSync(books, moved, { recursive: true });
    fs.rmSync(books, { recursive: true });
    // Reconnecting to its own current path, or the new one, is fine.
    expect((await api.post(`/api/folders/${id}/reconnect`, { path: moved })).status).toBe(200);
    expect((await api.post(`/api/folders/${id}/reconnect`, { path: moved })).status).toBe(200);
    await api.post('/api/scan', {});
    await made.scans.wait();
    expect(db.prepare('SELECT id FROM files').pluck().all()).toEqual(before);
    expect(db.prepare('SELECT availability FROM files').pluck().all()).toEqual(['present']);
  });
});

describe('folders already nested in the library', () => {
  it('names both in Library health and changes nothing', async () => {
    const books = dir('Books');
    await api.post('/api/folders', { path: books });
    const comics = dir('Books', 'Comics');
    // Added before the check existed.
    db.prepare(
      `INSERT INTO folders (id, display_path, relative_path, storage_kind, created_at, updated_at)
       VALUES ('old-nested', ?, 'Books/Comics', 'external', '2026-01-01', '2026-01-01')`,
    ).run(comics);
    const h = (await api.get('/api/health')).body;
    expect(h.nestedFolders).toEqual([{ inner: comics, outer: books }]);
    expect(db.prepare('SELECT COUNT(*) FROM folders').pluck().get()).toBe(2);
  });
});

describe('Library paging past 1,000 books', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const title = `Ledger ${String(i + 1).padStart(4, '0')}`;
      return { id: title, title, user: { hidden: false } } as unknown as ItemSummary;
    });

  it('returns the last 150 of 1,150 from offset 1,000', () => {
    const r = queryLibrary(many(1150), { offset: 1000, limit: 100 * 10 });
    expect(r.total).toBe(1150);
    expect(r.items).toHaveLength(150);
    expect(r.items[0]!.title).toBe('Ledger 1001');
    expect(r.items.at(-1)!.title).toBe('Ledger 1150');
  });

  it('pages through /api/items 100 at a time to the very end', async () => {
    for (let i = 1; i <= 1150; i++)
      createStoreItem(db, {
        title: `Ledger ${String(i).padStart(4, '0')}`,
        author: null,
        store: 'kindle',
      });
    const r = await api.get('/api/items?offset=1000&limit=100');
    expect(r.body.total).toBe(1150);
    expect(r.body.items.map((i: { title: string }) => i.title)).toEqual(
      Array.from({ length: 100 }, (_, i) => `Ledger ${1001 + i}`),
    );
    const last = await api.get('/api/items?offset=1100&limit=100');
    expect(last.body.items).toHaveLength(50);
    expect(last.body.items.at(-1).title).toBe('Ledger 1150');
  });

  it('continues after a given book, however many were added before it', async () => {
    for (let i = 1; i <= 250; i++)
      createStoreItem(db, {
        title: `Ledger ${String(i).padStart(4, '0')}`,
        author: null,
        store: 'kindle',
      });
    const first = (await api.get('/api/items?limit=100')).body;
    expect(first.hasMore).toBe(true);
    const lastShown = first.items.at(-1).id as string;
    // A new book sorting first arrives between the two pages.
    createStoreItem(db, { title: 'Aardvark Atlas', author: null, store: 'kindle' });
    const next = (await api.get(`/api/items?after=${lastShown}&limit=100`)).body;
    expect(next.total).toBe(251);
    expect(next.items[0].title).toBe('Ledger 0101');
    expect(next.items).toHaveLength(100);
    const end = (await api.get(`/api/items?after=${next.items.at(-1).id}&limit=100`)).body;
    expect(end.items.map((i: { title: string }) => i.title).at(-1)).toBe('Ledger 0250');
    expect(end.hasMore).toBe(false);
  });

  it('says so when the book to continue after is no longer in the list', async () => {
    createStoreItem(db, { title: 'Ledger 0001', author: null, store: 'kindle' });
    const r = (await api.get('/api/items?after=gone-book&limit=100')).body;
    expect(r).toMatchObject({ items: [], hasMore: false, anchorMissing: true, total: 1 });
  });
});
