import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { parseCsv, progressFrom, ratingFrom } from './lib/store.ts';
import type { Fetcher } from './sources/types.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Store titles and the store CSV import (M4: PLAN.md §14). Invented books, except where a
 * recorded Open Library answer is replayed. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'sources');

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;

const fetcher: Fetcher = async (url) => {
  const u = new URL(url);
  const body =
    u.hostname === 'openlibrary.org' && /time machine/i.test(u.searchParams.get('title') ?? '')
      ? fs.readFileSync(path.join(FIXTURES, 'ol-search-time-machine.json'), 'utf8')
      : fs.readFileSync(path.join(FIXTURES, 'ol-search-none.json'), 'utf8');
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
  delete: (url: string) => request(made.app).delete(url).set('Host', HOST).send({}),
};

beforeEach(async () => {
  drive = tempDir('wbn-m4-store-');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
    fetcher,
  });
  writeFiles(drive, {
    'ember.epub': makeEpub({
      title: 'The Ember Orchard',
      creators: ['Nell Varga'],
      identifiers: ['9780000000017'],
      chapters: [900],
    }),
    'tidewright.epub': makeEpub({ title: 'Tidewright', creators: ['Osric Lane'], chapters: [900] }),
  });
  await api.post('/api/folders', { path: drive });
  await api.post('/api/scan', {});
  await made.scans.wait();
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

const itemOf = (name: string) =>
  db
    .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?')
    .pluck()
    .get(name) as string;

describe('store titles (§14)', () => {
  it('adds a typed-in Kindle book, labelled and recommended, ready to read only once confirmed', async () => {
    const r = await api.post('/api/store/items', {
      title: 'Lanterns Over Harrowgate',
      author: 'Pell Inchcape',
      store: 'kindle',
      kind: 'fiction',
    });
    expect(r.status).toBe(200);
    const item = (await api.get(`/api/items/${r.body.itemId}`)).body;
    expect(item.availability).toMatchObject({
      state: 'store',
      label: 'In Kindle',
      readyToRead: false,
    });
    expect(item.kind).toBe('fiction');
    const cards = (await api.get('/api/next')).body.cards.map((c: { id: string }) => c.id);
    expect(cards).toContain(r.body.itemId);
    const [loc] = (await api.get(`/api/items/${r.body.itemId}/locations`)).body;
    await api.patch(`/api/locations/${loc.id}`, { readable: true });
    expect((await api.get(`/api/items/${r.body.itemId}`)).body.availability.readyToRead).toBe(true);
  });

  it('adds a book picked from a search, and joins the book that already has that match', async () => {
    const s = (await api.post('/api/store/search', { query: 'The Time Machine' })).body;
    expect(s.results[0]).toMatchObject({ source: 'Open Library', title: 'The Time Machine' });
    const first = (
      await api.post('/api/store/items', { store: 'kindle', pick: { token: s.token, index: 0 } })
    ).body;
    expect(first.joined).toBe(false);
    expect(db.prepare('SELECT identity FROM items WHERE id = ?').pluck().get(first.itemId)).toBe(
      'accepted',
    );
    const again = (
      await api.post('/api/store/items', {
        store: 'apple_books',
        pick: { token: s.token, index: 0 },
      })
    ).body;
    expect(again).toEqual({ itemId: first.itemId, joined: true });
    expect((await api.get(`/api/items/${first.itemId}/locations`)).body).toHaveLength(2);
  });

  it('removes a store book, but never a book with files', async () => {
    const r = (await api.post('/api/store/items', { title: 'Gone Astray', store: 'kobo' })).body;
    expect((await api.delete(`/api/items/${r.itemId}`)).status).toBe(200);
    expect((await api.delete(`/api/items/${itemOf('tidewright.epub')}`)).status).toBe(409);
  });
});

describe('store CSV (§14)', () => {
  const CSV = [
    'title,author,store,kind,progress,isbn,series,series_index,rating,note',
    'Lanterns Over Harrowgate,Pell Inchcape,Kindle,fiction,read,,,,4/5,"A slow, good one"',
    'Ember Orchard (Kindle edition),,Kindle,,,978-0-00-000001-7,,,,',
    'Tidewright,Osric Lane,Apple Books,,currently-reading,,,,8,',
    '"Quills, Volume Two",Ada Penhallow,Google Play,,,,Quills,2,,',
  ].join('\r\n');

  it('reads quoted fields, ratings and progress as written, and nothing else', () => {
    expect(parseCsv('a,"b, c","d ""e"""\n1,"two\nlines",3')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', 'two\nlines', '3'],
    ]);
    expect([ratingFrom('4/5'), ratingFrom('★★★'), ratingFrom('8'), ratingFrom('great')]).toEqual([
      8,
      6,
      8,
      null,
    ]);
    expect([
      progressFrom('read'),
      progressFrom('currently-reading'),
      progressFrom('to-read'),
      progressFrom('soon'),
    ]).toEqual(['finished', 'into_it', 'not_started', null]);
  });

  it('previews new books, ISBN matches and possible matches before anything changes', async () => {
    const p = (await api.post('/api/import/csv/preview', { text: CSV })).body;
    expect(p.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      'new',
      'isbn',
      'possible',
      'new',
    ]);
    expect(p.rows[1].itemId).toBe(itemOf('ember.epub'));
    expect(p.rows[0].applies).toEqual(['progress finished', 'rating 8/10', 'note']);
    expect(db.prepare('SELECT COUNT(*) FROM locations').pluck().get()).toBe(0);
  });

  it('imports as previewed, and a second import duplicates nothing and keeps the owner’s edits', async () => {
    const tide = itemOf('tidewright.epub');
    const r1 = (await api.post('/api/import/csv', { text: CSV, attach: [4], keepNew: true })).body;
    expect(r1).toEqual({ added: 2, attached: 2, already: 0, skipped: 0 });
    expect((await api.get(`/api/items/${tide}`)).body.user.progress).toBe('into_it');
    const lantern = db
      .prepare("SELECT id FROM items WHERE title = 'Lanterns Over Harrowgate'")
      .pluck()
      .get() as string;
    expect((await api.get(`/api/items/${lantern}`)).body.user).toMatchObject({
      progress: 'finished',
      finishedOn: null,
      finishedPrecision: 'unknown',
      rating: 8,
    });
    // The owner changes a rating; the file still says 8.
    await api.patch(`/api/items/${lantern}`, { rating: 5 });
    const p2 = (await api.post('/api/import/csv/preview', { text: CSV })).body;
    expect(p2.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      'already',
      'already',
      'already',
      'already',
    ]);
    expect(p2.rows[0].kept).toEqual(['rating: the file says 8/10, yours is 5/10']);
    const before = db.prepare('SELECT COUNT(*) FROM items').pluck().get();
    expect(
      (await api.post('/api/import/csv', { text: CSV, attach: [], keepNew: true })).body.already,
    ).toBe(4);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(before);
    expect((await api.get(`/api/items/${lantern}`)).body.user.rating).toBe(5);
  });

  it('skips rows matching nothing when asked, and puts the series number in place', async () => {
    const r = (await api.post('/api/import/csv', { text: CSV, attach: [], keepNew: false })).body;
    expect(r).toEqual({ added: 0, attached: 1, already: 0, skipped: 3 });
    await api.post('/api/import/csv', { text: CSV, attach: [], keepNew: true });
    const quills = db
      .prepare("SELECT series_position FROM items WHERE title = 'Quills, Volume Two'")
      .pluck()
      .get();
    expect(quills).toBe(2);
  });

  it('keeps intentionally cleared progress, ratings and notes on a repeat store import', async () => {
    const text =
      'title,author,store,progress,rating,note\nImported Rain Ledger,Ada Fen,Kindle,read,4/5,Imported note';
    await api.post('/api/import/csv', { text, keepNew: true });
    const id = db
      .prepare("SELECT id FROM items WHERE title = 'Imported Rain Ledger'")
      .pluck()
      .get() as string;
    await api.patch(`/api/items/${id}`, { progress: 'not_started', rating: null, note: null });
    const preview = (await api.post('/api/import/csv/preview', { text })).body;
    expect(preview.rows[0]).toMatchObject({ outcome: 'already', applies: [] });
    expect((await api.post('/api/import/csv', { text, keepNew: true })).body).toEqual({
      added: 0,
      attached: 0,
      already: 1,
      skipped: 0,
    });
    expect((await api.get(`/api/items/${id}`)).body.user).toMatchObject({
      progress: 'not_started',
      finishedOn: null,
      rating: null,
      note: null,
    });
  });

  it('says plainly what it can’t use', async () => {
    const r = await api.post('/api/import/csv/preview', { text: 'name,writer\nX,Y' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/including “title”/);
  });
});
