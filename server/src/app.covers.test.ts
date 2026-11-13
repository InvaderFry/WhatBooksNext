import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { coverCandidates } from './identify/covers.ts';
import { fakePlatformWithDrives, memoryDb, tempDir } from './testing/helpers.ts';

/**
 * Covers for books without a file cover, from the book's confident match (owner decisions
 * 2026-11-11 and 2026-11-13): Open Library by cover ID, other sources by the cover address stored
 * with the match, kept in the data folder. Fake sources answer; every ID and address is invented.
 */

const PORT = 4837;
const HOST = `localhost:${PORT}`;

let db: DB;
let dataDir: string;
let made: ReturnType<typeof createApp>;
let asked: { url: string; ua: string | null; auth: string | null }[];
let works: Record<string, unknown>;
let pictures: Record<string, Response | 'offline'>;
let hosted: Record<string, Response | 'offline'>;

const jpeg = () => {
  const c = createCanvas(20, 30);
  const g = c.getContext('2d');
  g.fillStyle = '#336699';
  g.fillRect(0, 0, 20, 30);
  return c.toBuffer('image/jpeg');
};

beforeEach(async () => {
  dataDir = tempDir('wbn-covers-');
  db = await memoryDb();
  asked = [];
  works = {};
  pictures = {};
  hosted = {};
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: PORT,
    dataDir,
    snapshotDir: null,
    autoLookups: false,
    fetcher: async (url, init) => {
      asked.push({
        url,
        ua: new Headers(init?.headers as Record<string, string>).get('user-agent'),
        auth: new Headers(init?.headers as Record<string, string>).get('authorization'),
      });
      const u = new URL(url);
      if (u.hostname === 'openlibrary.org' && u.pathname.endsWith('.json')) {
        const w = works[u.pathname.replace(/\.json$/, '')];
        return w === undefined
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(w), { headers: { 'content-type': 'application/json' } });
      }
      if (u.hostname === 'covers.openlibrary.org') {
        const p = pictures[u.pathname];
        if (p === 'offline') throw new Error('connection refused');
        return p ?? new Response('', { status: 404 });
      }
      if (u.hostname === 'cdn.hardcover.app' || u.hostname === 'static.metron.cloud') {
        const p = hosted[url];
        if (p === 'offline') throw new Error('connection refused');
        return p ?? new Response('', { status: 404 });
      }
      return new Response('{}', { status: 404 });
    },
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
};

/** A store book, matched to an Open Library work the way the owner's confirmation records it. */
async function bookMatchedTo(work: string, title = 'The Orchard Ledger'): Promise<string> {
  const { itemId } = (await api.post('/api/store/items', { title, store: 'kindle' })).body;
  override(itemId, `openlibrary:${work}`);
  return itemId;
}

/** The owner's chosen match (a store book has no user_item row until something is recorded). */
function override(itemId: string, value: string | null) {
  db.prepare(
    `INSERT INTO user_item (item_id, match_override, updated_at) VALUES (?, ?, '2026-11-11')
     ON CONFLICT (item_id) DO UPDATE SET match_override = excluded.match_override`,
  ).run(itemId, value);
}

/** The same, accepted by the app on its own (lookup_state remembers it). */
function acceptedBy(itemId: string, work: string) {
  db.prepare(
    `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome, accepted_source_id)
     VALUES (?, 'openlibrary', 1, 'q', '2026-11-11T00:00:00Z', 'matched', ?)`,
  ).run(itemId, work);
}

const run = async () => {
  made.covers.start();
  await made.covers.wait();
};

describe('covers from Open Library', () => {
  it('saves the first cover of a confirmed match, and shows it on the book', async () => {
    works['/works/OL101W'] = { covers: [-1, 9001, 9002] };
    pictures['/b/id/9001-M.jpg'] = new Response(jpeg(), {
      headers: { 'content-type': 'image/jpeg' },
    });
    const id = await bookMatchedTo('/works/OL101W');
    await run();
    expect(asked.map((a) => a.url)).toEqual([
      'https://openlibrary.org/works/OL101W.json',
      'https://covers.openlibrary.org/b/id/9001-M.jpg',
    ]);
    // Through Open Library's own client: the app's User-Agent on every request.
    expect(asked.every((a) => a.ua && /whatBooksNext/i.test(a.ua))).toBe(true);
    expect(db.prepare('SELECT state, cover_id FROM item_covers').get()).toEqual({
      state: 'ok',
      cover_id: '9001',
    });
    expect(fs.existsSync(path.join(dataDir, 'covers', `item-${id}.jpg`))).toBe(true);
    expect((await api.get(`/api/items/${id}`)).body.coverItemId).toBe(id);
    const pic = await api.get(`/api/items/${id}/cover`);
    expect(pic.status).toBe(200);
    expect(pic.headers['content-type']).toMatch(/image\/jpeg/);
    // Done once: nothing is asked again.
    await run();
    expect(asked).toHaveLength(2);
  });

  it('also covers a match the app accepted on its own', async () => {
    works['/works/OL102W'] = { covers: [9003] };
    pictures['/b/id/9003-M.jpg'] = new Response(jpeg(), {
      headers: { 'content-type': 'image/jpeg' },
    });
    const { itemId } = (await api.post('/api/store/items', { title: 'Tidewright', store: 'kobo' }))
      .body;
    acceptedBy(itemId, '/works/OL102W');
    await run();
    expect((await api.get(`/api/items/${itemId}`)).body.coverItemId).toBe(itemId);
  });

  it('records a work with no cover and doesn’t ask again for a month', async () => {
    works['/works/OL103W'] = { covers: [] };
    const id = await bookMatchedTo('/works/OL103W');
    await run();
    expect(db.prepare('SELECT state FROM item_covers').pluck().get()).toBe('none');
    expect(coverCandidates(db)).toEqual([]);
    expect(coverCandidates(db, new Date(Date.now() + 31 * 86_400_000))).toEqual([
      { itemId: id, plans: [{ source: 'openlibrary', ref: '/works/OL103W' }] },
    ]);
    expect((await api.get(`/api/items/${id}`)).body.coverItemId).toBeNull();
    expect((await api.get(`/api/items/${id}/cover`)).status).toBe(404);
  });

  it('never covers an unconfirmed, rejected or non-Open Library match, or a malformed key', async () => {
    const { itemId: none } = (
      await api.post('/api/store/items', { title: 'No Match', store: 'kobo' })
    ).body;
    const rejected = await bookMatchedTo('/works/OL104W', 'Rejected');
    override(rejected, null);
    acceptedBy(rejected, '/works/OL104W');
    db.prepare(
      `INSERT INTO candidates_rejected (item_id, source, source_id, score, created_at)
       VALUES (?, 'openlibrary', '/works/OL104W', 0, '2026-11-11')`,
    ).run(rejected);
    const other = await bookMatchedTo('/works/OL105W', 'Elsewhere');
    override(other, 'hardcover:12345');
    acceptedBy(other, '/works/OL105W');
    await bookMatchedTo('../../etc/passwd', 'Odd');
    expect(none).toBeTruthy();
    expect(coverCandidates(db)).toEqual([]);
    await run();
    expect(asked).toEqual([]);
  });

  it('stops quietly when offline, recording nothing, so the next run tries again', async () => {
    works['/works/OL106W'] = { covers: [9006] };
    pictures['/b/id/9006-M.jpg'] = 'offline';
    await bookMatchedTo('/works/OL106W');
    await run();
    expect(db.prepare('SELECT COUNT(*) FROM item_covers').pluck().get()).toBe(0);
    expect(coverCandidates(db)).toHaveLength(1);
  });

  it('treats a missing picture as no cover, and a non-picture as unusable', async () => {
    works['/works/OL107W'] = { covers: [9007] };
    works['/works/OL108W'] = { covers: [9008] };
    pictures['/b/id/9008-M.jpg'] = new Response('<html>not a picture</html>', {
      headers: { 'content-type': 'text/html' },
    });
    await bookMatchedTo('/works/OL107W', 'Missing Picture');
    await bookMatchedTo('/works/OL108W', 'Not A Picture');
    await run();
    expect(
      db.prepare('SELECT source_ref, state FROM item_covers ORDER BY source_ref').all(),
    ).toEqual([
      { source_ref: '/works/OL107W', state: 'none' },
      { source_ref: '/works/OL108W', state: 'failed' },
    ]);
  });
});

const picture = () => new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } });

/** A stored candidate, the way a lookup or the owner's search keeps it. */
function candidate(itemId: string, source: string, id: string, coverUrl?: string) {
  db.prepare(
    `INSERT INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
     VALUES (?, ?, ?, 90, 1, '{}', ?, '2026-11-13T00:00:00Z')`,
  ).run(
    itemId,
    source,
    id,
    JSON.stringify({
      source,
      sourceId: id,
      title: 'Example',
      authors: [],
      isbns: [],
      subjects: [],
      coverUrl,
    }),
  );
}

/** The app accepted this source's record on its own. */
function acceptedOn(itemId: string, source: string, id: string) {
  db.prepare(
    `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome, accepted_source_id)
     VALUES (?, ?, 1, 'q', '2026-11-13T00:00:00Z', 'matched', ?)`,
  ).run(itemId, source, id);
}

async function storeBook(title: string): Promise<string> {
  return (await api.post('/api/store/items', { title, store: 'globalcomix' })).body.itemId;
}

describe('covers from other sources', () => {
  it('saves the cover of a confirmed Hardcover match, without sending any key', async () => {
    const id = await storeBook('Copperline Vol. 1');
    candidate(id, 'hardcover', '501', 'https://cdn.hardcover.app/copperline.jpg');
    override(id, 'hardcover:501');
    hosted['https://cdn.hardcover.app/copperline.jpg'] = picture();
    await run();
    expect(asked.map((a) => a.url)).toEqual(['https://cdn.hardcover.app/copperline.jpg']);
    expect(asked[0]!.auth).toBeNull();
    expect(db.prepare('SELECT state, source, source_ref FROM item_covers').get()).toEqual({
      state: 'ok',
      source: 'hardcover',
      source_ref: '501',
    });
    expect((await api.get(`/api/items/${id}`)).body.coverItemId).toBe(id);
    expect((await api.get(`/api/items/${id}/cover`)).status).toBe(200);
  });

  it('never fetches a cover address outside the source’s own image hosts', async () => {
    const id = await storeBook('Odd Host');
    candidate(id, 'hardcover', '502', 'https://example.com/cover.jpg');
    override(id, 'hardcover:502');
    expect(coverCandidates(db)).toEqual([]);
    await run();
    expect(asked).toEqual([]);
  });

  it('uses the confirmed match alone, never another source’s guess', async () => {
    const id = await storeBook('Owner Choice');
    candidate(id, 'hardcover', '503');
    override(id, 'hardcover:503');
    candidate(id, 'metron', '77', 'https://static.metron.cloud/media/77.jpg');
    acceptedOn(id, 'metron', '77');
    expect(coverCandidates(db)).toEqual([]);
  });

  it('tries each accepted match in turn when the first has no picture', async () => {
    const id = await storeBook('Two Sources #1');
    candidate(id, 'hardcover', '504', 'https://cdn.hardcover.app/gone.jpg');
    acceptedOn(id, 'hardcover', '504');
    candidate(id, 'metron', '78', 'https://static.metron.cloud/media/78.jpg');
    acceptedOn(id, 'metron', '78');
    hosted['https://static.metron.cloud/media/78.jpg'] = picture();
    await run();
    expect(asked.map((a) => a.url)).toEqual([
      'https://cdn.hardcover.app/gone.jpg',
      'https://static.metron.cloud/media/78.jpg',
    ]);
    expect(db.prepare('SELECT state, source FROM item_covers').get()).toEqual({
      state: 'ok',
      source: 'metron',
    });
  });

  it('replaces the cover when the owner confirms a different match, and drops it on "leave unidentified"', async () => {
    const id = await storeBook('Changed Mind');
    candidate(id, 'hardcover', '505', 'https://cdn.hardcover.app/first.jpg');
    candidate(id, 'hardcover', '506', 'https://cdn.hardcover.app/second.jpg');
    override(id, 'hardcover:505');
    hosted['https://cdn.hardcover.app/first.jpg'] = picture();
    hosted['https://cdn.hardcover.app/second.jpg'] = picture();
    await run();
    override(id, 'hardcover:506');
    await run();
    expect(db.prepare('SELECT source_ref FROM item_covers').pluck().get()).toBe('506');
    override(id, 'none');
    await run();
    expect(db.prepare('SELECT COUNT(*) FROM item_covers').pluck().get()).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'covers', `item-${id}.jpg`))).toBe(false);
    expect((await api.get(`/api/items/${id}`)).body.coverItemId).toBeNull();
  });

  it('waits when a source is offline, and still covers books from other sources', async () => {
    const a = await storeBook('Offline Source');
    candidate(a, 'hardcover', '507', 'https://cdn.hardcover.app/offline.jpg');
    override(a, 'hardcover:507');
    hosted['https://cdn.hardcover.app/offline.jpg'] = 'offline';
    const b = await storeBook('Online Source');
    candidate(b, 'metron', '79', 'https://static.metron.cloud/media/79.jpg');
    override(b, 'metron:79');
    hosted['https://static.metron.cloud/media/79.jpg'] = picture();
    await run();
    expect(db.prepare('SELECT item_id FROM item_covers').pluck().all()).toEqual([b]);
  });
});

describe('online covers in Diagnostics', () => {
  it('counts saved covers by source and gets covers when the owner asks', async () => {
    const id = await storeBook('Asked For');
    candidate(id, 'hardcover', '508', 'https://cdn.hardcover.app/asked.jpg');
    override(id, 'hardcover:508');
    hosted['https://cdn.hardcover.app/asked.jpg'] = picture();
    const before = (await api.get('/api/diagnostics')).body.onlineCovers;
    expect(before).toMatchObject({ bySource: {}, waiting: 1, automatic: false });
    expect((await api.post('/api/covers/fetch')).status).toBe(200);
    await made.covers.wait();
    const after = (await api.get('/api/diagnostics')).body.onlineCovers;
    expect(after).toMatchObject({ bySource: { hardcover: 1 }, waiting: 0, running: false });
  });
});
