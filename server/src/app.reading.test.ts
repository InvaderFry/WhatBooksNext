import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { createBackup } from './lib/backup.ts';
import type { Fetcher } from './sources/types.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Routes added with lookups and recommendations (M3), against recorded source responses. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'sources');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;
let requests: string[];
/** Open Library answers by title; anything unknown gets the recorded "nothing found". */
let olByTitle: Record<string, string>;
let failing: boolean;

const fetcher: Fetcher = async (url) => {
  requests.push(url);
  if (failing) return new Response('down', { status: 503 });
  const u = new URL(url);
  if (u.hostname === 'openlibrary.org') {
    const title = (u.searchParams.get('title') ?? '').toLowerCase();
    const body = olByTitle[title] ?? fixture('ol-search-none.json');
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
  put: (url: string, body: object) => request(made.app).put(url).set('Host', HOST).send(body),
};

beforeEach(async () => {
  drive = tempDir('wbn-m3-drive-');
  requests = [];
  failing = false;
  olByTitle = {
    'the time machine': fixture('ol-search-time-machine.json'),
    'pride and prejudice': fixture('ol-search-pride-prejudice.json'),
  };
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    fetcher,
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

/** Adds the drive, scans it, and waits for the lookups that follow a scan. */
async function addAndScan(files: Record<string, Buffer | number>) {
  writeFiles(drive, files);
  expect((await api.post('/api/folders', { path: drive })).status).toBe(200);
  await api.post('/api/scan', {});
  await made.scans.wait();
  await made.lookups.wait();
}

const itemIdOf = (name: string) =>
  db
    .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?')
    .pluck()
    .get(name) as string;

const timeMachine = () =>
  makeEpub({ title: 'The Time Machine', creators: ['H. G. Wells'], chapters: [1500, 1500] });

describe('lookups', () => {
  it('looks new books up after a scan and uses an accepted match’s rating', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const online = (await api.get(`/api/items/${itemIdOf('thetimemachine.epub')}/online`)).body;
    expect(online.identity).toBe('accepted');
    expect(online.community).toMatchObject({ source: 'openlibrary', votes: 134, scope: 'book' });
    expect(online.firstPublishYear).toBe(1895);
    // The kind follows from the subjects when the file doesn't say.
    const item = (await api.get(`/api/items/${itemIdOf('thetimemachine.epub')}`)).body;
    expect(item.kind).toBe('fiction');
    expect(item.kindIsGuess).toBe(true);
  });

  it('makes no new requests when nothing changed since the last lookup', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const before = requests.length;
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    expect(requests.length).toBe(before);
  });

  it('keeps an item’s candidates when a later lookup fails (a failure never erases data)', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    failing = true;
    const r = await api.post(`/api/items/${id}/lookup`, {});
    expect(r.body.results[0].outcome).toBe('failed');
    expect((await api.get(`/api/items/${id}/online`)).body.identity).toBe('accepted');
  });

  it('stops, and says why, when the connection drops instead of failing the whole library', async () => {
    failing = true;
    const books: Record<string, Buffer> = {};
    for (let i = 0; i < 14; i++)
      books[`book${i}.epub`] = makeEpub({ title: `Lost Signal ${i}`, chapters: [600] });
    await addAndScan(books);
    const status = (await api.get('/api/lookups')).body.status;
    expect(status.status).toBe('failed');
    expect(status.done).toBe(10);
    expect(status.error).toMatch(/Couldn’t reach the online sources/);
    // The books not reached were left alone, and every book still counts as waiting.
    expect(db.prepare('SELECT COUNT(*) FROM lookup_state').pluck().get()).toBe(10);
    expect((await api.get('/api/lookups')).body.pending).toBe(14);
    // Back online, the next run carries on.
    failing = false;
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    expect((await api.get('/api/lookups')).body.pending).toBe(0);
  });

  it('never asks book sources about a single comic or magazine issue', async () => {
    olByTitle['copperline'] = fixture('ol-search-time-machine.json');
    await addAndScan({ 'Copperline 048.pdf': 30_000 });
    expect(requests.filter((u) => u.includes('openlibrary'))).toHaveLength(0);
    const report = (await api.get('/api/match-report')).body;
    expect(report.byBand).toMatchObject({ noSourceYet: 1, notLookedUp: 0 });
  });

  it('drops candidates from sources that no longer apply when the next run starts', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    // Candidates from Hardcover, left over from when a token was saved; the token is gone now.
    const rec = JSON.stringify({
      source: 'hardcover',
      sourceId: '9',
      title: 'The Time Machine',
      authors: ['H. G. Wells'],
      isbns: [],
      subjects: [],
      rating: { value: 4.9, scale: 5, count: 9999, scope: 'book' },
    });
    db.prepare(
      `INSERT INTO item_matches VALUES (?, 'hardcover', '9', 1, 1, '{}', ?, '2026-01-01')`,
    ).run(id, rec);
    db.prepare(
      `INSERT INTO lookup_state VALUES (?, 'hardcover', 4, '{}', '2026-01-01', 'matched', NULL)`,
    ).run(id);
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    const online = (await api.get(`/api/items/${id}/online`)).body;
    expect(online.community.source).toBe('openlibrary');
    expect(online.candidates.every((c: { source: string }) => c.source !== 'hardcover')).toBe(true);
  });

  it('leaves a book unidentified, with neutral scores, when nothing matches', async () => {
    await addAndScan({
      'unknownbook.epub': makeEpub({ title: 'Nothing Like It', chapters: [900] }),
    });
    const online = (await api.get(`/api/items/${itemIdOf('unknownbook.epub')}/online`)).body;
    expect(online.identity).toBe('unidentified');
    expect(online.community).toBeNull();
  });
});

describe('Needs review: identities (§11.4)', () => {
  // Two different works that a filename-only title matches equally well (scenario 18).
  const twoWorks = JSON.stringify({
    numFound: 2,
    docs: [
      { key: '/works/OL1W', title: 'The Glass Bell', author_name: ['Ann Example'] },
      { key: '/works/OL2W', title: 'Glass Bell', author_name: ['Bea Other'] },
    ],
  });

  it('leaves tied candidates provisional and shows both in tier 2 (scenario 18)', async () => {
    olByTitle['the glass bell'] = twoWorks;
    await addAndScan({ 'theglassbell.pdf': 30_000 });
    const id = itemIdOf('theglassbell.pdf');
    const review = (await api.get('/api/review')).body;
    const row = review.rows.find((r: { id: string }) => r.id === `identity:${id}`);
    expect(row).toMatchObject({ kind: 'tie', tier: 2 });
    expect(row.candidates).toHaveLength(2);
    expect((await api.get(`/api/items/${id}/online`)).body.identity).toBe('tie');

    // The owner picks one: it's used, and the row goes.
    await api.post(`/api/items/${id}/match`, {
      action: 'confirm',
      source: 'openlibrary',
      sourceId: '/works/OL2W',
    });
    expect((await api.get(`/api/items/${id}/online`)).body).toMatchObject({
      identity: 'accepted',
      matchConfirmed: true,
    });
    const after = (await api.get('/api/review')).body;
    expect(after.rows.find((r: { id: string }) => r.id === `identity:${id}`)).toBeUndefined();
  });

  it('never accepts a rejected candidate again, even after looking up again', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    const chosen = (await api.get(`/api/items/${id}/online`)).body.sources[0].chosen.sourceId;
    await api.post(`/api/items/${id}/match`, {
      action: 'reject',
      source: 'openlibrary',
      sourceId: chosen,
    });
    await api.post(`/api/items/${id}/lookup`, {});
    const online = (await api.get(`/api/items/${id}/online`)).body;
    expect(online.sources[0].chosen?.sourceId).not.toBe(chosen);
    const report = (await api.get('/api/match-report')).body;
    expect(report.labelled.wrongHighConfidence).toBe(1);
  });

  it('“Leave unidentified” stops the item being matched and is never overwritten by a lookup', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    await api.post(`/api/items/${id}/match`, { action: 'none' });
    await api.post(`/api/items/${id}/lookup`, {});
    expect((await api.get(`/api/items/${id}/online`)).body.identity).toBe('unidentified');
  });

  it('“Wrong book” from a card sends the item to tier 2', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    await api.post('/api/feedback', { itemId: id, reason: 'wrong_book', mode: 'read_next' });
    const row = (await api.get('/api/review')).body.rows.find(
      (r: { id: string }) => r.id === `identity:${id}`,
    );
    expect(row).toMatchObject({ kind: 'wrong_match', tier: 2 });
  });

  it('defers and dismisses review rows', async () => {
    olByTitle['the glass bell'] = twoWorks;
    await addAndScan({ 'theglassbell.pdf': 30_000 });
    const key = `identity:${itemIdOf('theglassbell.pdf')}`;
    await api.post('/api/review-state', { key, state: 'deferred' });
    let review = (await api.get('/api/review')).body;
    expect(review.rows.some((r: { id: string }) => r.id === key)).toBe(false);
    expect(review.hidden).toBe(1);
    await api.post('/api/review-state', { key, state: null });
    review = (await api.get('/api/review')).body;
    expect(review.rows.some((r: { id: string }) => r.id === key)).toBe(true);
  });

  it('confirms every cross-folder suggestion at once, after a preview', async () => {
    await addAndScan({
      'A/fieldnotes.epub': makeEpub({ title: 'Field Notes', chapters: [700] }),
      'B/fieldnotes.pdf': 40_000,
      'A/riverbook.epub': makeEpub({ title: 'River Book', chapters: [700] }),
      'B/riverbook.pdf': 41_000,
    });
    const preview = (await api.post('/api/review/bulk', { kind: 'cross_folder', action: 'accept' }))
      .body;
    expect(preview).toMatchObject({ total: 2, done: 2 });
    expect(itemIdOf('fieldnotes.epub')).not.toBe(itemIdOf('fieldnotes.pdf'));
    const done = (
      await api.post('/api/review/bulk', { kind: 'cross_folder', action: 'accept', preview: false })
    ).body;
    expect(done.done).toBe(2);
    expect(itemIdOf('fieldnotes.epub')).toBe(itemIdOf('fieldnotes.pdf'));
  });
});

describe('Read next and its cards', () => {
  it('recommends with zero keys and no triage, and the shortlist works (scenario 8)', async () => {
    await addAndScan({
      'thetimemachine.epub': timeMachine(),
      'unknownbook.epub': makeEpub({ title: 'Nothing Like It', chapters: [900] }),
    });
    const next = (await api.get('/api/next?time=any')).body;
    expect(next.cards.map((c: { title: string }) => c.title).sort()).toEqual([
      'Nothing Like It',
      'The Time Machine',
    ]);
    expect(next.hardcover).toBe(false);
    const id = next.cards[0].id;
    expect((await api.post('/api/shortlist', { itemId: id })).status).toBe(200);
    expect(
      (await api.get('/api/next?time=any')).body.cards.find((c: { id: string }) => c.id === id)
        .shortlisted,
    ).toBe(true);
  });

  it('“Already read” with no date leaves the backlog without a finish date (scenario 6)', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    await api.post('/api/feedback', { itemId: id, reason: 'already_read', mode: 'read_next' });
    const item = (await api.get(`/api/items/${id}`)).body;
    expect(item.user).toMatchObject({
      progress: 'finished',
      finishedOn: null,
      finishedPrecision: 'unknown',
    });
    expect((await api.get('/api/next?time=any')).body.cards).toHaveLength(0);
    expect(db.prepare('SELECT reason FROM pick_feedback').pluck().all()).toEqual(['already_read']);
  });

  it('returns a source’s description as plain text, exactly as received (scenario 23)', async () => {
    olByTitle['the time machine'] = JSON.stringify({
      docs: [{ key: '/works/OL9W', title: 'The Time Machine', author_name: ['H. G. Wells'] }],
    });
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const id = itemIdOf('thetimemachine.epub');
    db.prepare(
      "UPDATE item_matches SET data = json_set(data, '$.description', ?) WHERE item_id = ?",
    ).run('<p>Hi</p><script>alert(1)</script>', id);
    const online = (await api.get(`/api/items/${id}/online`)).body;
    expect(online.description).toBe('<p>Hi</p><script>alert(1)</script>');
  });

  it('never renders HTML from files or sources in the web UI (scenario 23)', () => {
    const web = path.join(import.meta.dirname, '..', '..', 'web', 'src');
    const files = fs
      .readdirSync(web, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f));
    for (const f of files)
      expect(fs.readFileSync(path.join(web, f), 'utf8'), f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML/,
      );
  });

  it('offers untriaged books for triage and records Want / Maybe / Never', async () => {
    await addAndScan({ 'thetimemachine.epub': timeMachine() });
    const t = (await api.get('/api/triage')).body;
    expect(t.items).toHaveLength(1);
    await api.patch(`/api/items/${t.items[0].id}`, { triage: 'never' });
    expect((await api.get('/api/triage')).body.items).toHaveLength(0);
    expect((await api.get('/api/next?time=any')).body.cards).toHaveLength(0);
    // Undo puts it back.
    await api.patch(`/api/items/${t.items[0].id}`, { triage: null });
    expect((await api.get('/api/triage')).body.items).toHaveLength(1);
  });
});

describe('the Hardcover token (§6.3)', () => {
  it('is stored masked, revealed only on request, and never in a backup', async () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect((await api.put('/api/settings/hardcover', { token: `Bearer ${token}` })).status).toBe(
      200,
    );
    const s = (await api.get('/api/settings/hardcover')).body;
    expect(s).toMatchObject({ configured: true, masked: '••••6789' });
    expect(JSON.stringify(s)).not.toContain(token);
    expect((await api.get('/api/settings/hardcover/reveal')).body.token).toBe(token);
    expect(JSON.stringify(createBackup(db))).not.toContain(token);
    expect(JSON.stringify((await api.get('/api/diagnostics')).body)).not.toContain(token);
  });

  it('refuses something that isn’t a token', async () => {
    expect((await api.put('/api/settings/hardcover', { token: 'oops' })).status).toBe(400);
  });
});
