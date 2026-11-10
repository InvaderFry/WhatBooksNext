import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import type { FakePlatform } from './platform/fake.ts';
import { makeEpub, makeImage, makePdf, makeZip, textLines } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Routes added with the deep pass (M2): covers, file details, review, health, reminders. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;

let db: DB;
let drive: string;
let dataDir: string;
let platform: FakePlatform;
let made: ReturnType<typeof createApp>;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
};

beforeEach(async () => {
  drive = tempDir('wbn-deep-drive-');
  dataDir = tempDir('wbn-deep-data-');
  platform = fakePlatformWithDrives({ drive });
  db = await memoryDb();
  made = createApp({ db, platform, port: PORT, dataDir, snapshotDir: null, autoLookups: false });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function scan() {
  await api.post('/api/scan', {});
  return made.scans.wait();
}

async function addAndScan(files: Record<string, Buffer | number>) {
  writeFiles(drive, files);
  const add = await api.post('/api/folders', { path: drive });
  expect(add.status).toBe(200);
  await scan();
  return add.body.id as string;
}

const itemIdOf = (name: string) =>
  db
    .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?')
    .pluck()
    .get(name) as string;

describe('covers', () => {
  it('serves a cover by file id from the data folder, and nothing for an unknown id', async () => {
    await addAndScan({ 'a.epub': makeEpub({ title: 'A', cover: true }) });
    const item = (await api.get(`/api/items/${itemIdOf('a.epub')}`)).body;
    expect(item.coverFileId).toBe(item.files[0].id);
    const r = await api.get(`/api/files/${item.coverFileId}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/jpeg/);
    expect((await api.get('/api/files/..%2F..%2Fsecret/thumbnail')).status).toBe(404);
  });

  it('shows the file’s own details on the item page, with description text kept as text', async () => {
    await addAndScan({
      'b.epub': makeEpub({
        title: 'B',
        language: 'en',
        chapters: [400],
        description: 'Hello <script>alert(1)</script><b>world</b>',
      }),
    });
    const item = (await api.get(`/api/items/${itemIdOf('b.epub')}`)).body;
    expect(item.titleSource).toBe('embedded');
    expect(item.files[0]).toMatchObject({ wordCount: 400, language: 'en', hashed: true });
    expect(item.files[0].metadata.description).toBe('Hello world');
  });
});

describe('PDF type correction', () => {
  it('lets the owner say an uncertain PDF is a comic, which makes the item a comic and clears the review row', async () => {
    const page = { image: makeImage(400, 615, 'jpeg', '#000', true), imageGray: true };
    await addAndScan({
      'greyscans.pdf': makePdf({ pages: [page, page, page, page], width: 400, height: 615 }),
    });
    const id = itemIdOf('greyscans.pdf');
    let review = (await api.get('/api/review')).body;
    expect(review.rows).toEqual([expect.objectContaining({ kind: 'pdf_type', tier: 4 })]);
    const fileId = review.rows[0].files[0].id;
    expect((await api.patch(`/api/files/${fileId}`, { pdfTypeOverride: 'comic' })).status).toBe(
      200,
    );
    expect((await api.get(`/api/items/${id}`)).body).toMatchObject({ kind: 'comic' });
    review = (await api.get('/api/review')).body;
    expect(review.rows).toEqual([]);
    // A scan never undoes the owner's correction.
    await scan();
    expect((await api.get(`/api/items/${id}`)).body.kind).toBe('comic');
  });

  it('refuses a PDF type on a file that isn’t a PDF', async () => {
    await addAndScan({ 'c.epub': makeEpub({ title: 'C' }) });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    expect((await api.patch(`/api/files/${fileId}`, { pdfTypeOverride: 'comic' })).status).toBe(
      400,
    );
  });
});

describe('Needs review actions', () => {
  it('a confirmed move keeps the progress', async () => {
    const head = Buffer.alloc(70_000, 7);
    await addAndScan({ 'oldname.pdf': Buffer.concat([head, Buffer.alloc(50_000, 1), head]) });
    const id = itemIdOf('oldname.pdf');
    await api.patch(`/api/items/${id}`, { progress: 'halfway' });
    // Its full hash was never recorded (it went missing before hashing finished), so only
    // the size and partial hash can be compared: the owner decides.
    db.prepare('UPDATE files SET full_hash = NULL').run();
    fs.rmSync(path.join(drive, 'oldname.pdf'));
    writeFiles(drive, { 'newname.pdf': Buffer.concat([head, Buffer.alloc(50_000, 2), head]) });
    await scan();
    expect(itemIdOf('newname.pdf')).not.toBe(id);
    let review = (await api.get('/api/review')).body;
    const row = review.rows.find((r: { kind: string }) => r.kind === 'move');
    expect((await api.post(`/api/review/${row.id}`, { action: 'accept' })).status).toBe(200);
    expect(itemIdOf('newname.pdf')).toBe(id);
    expect((await api.get(`/api/items/${id}`)).body.user.progress).toBe('halfway');
    review = (await api.get('/api/review')).body;
    expect(review.rows).toEqual([]);
  });

  it('accepting a cross-folder suggestion joins the two items; declining it is remembered', async () => {
    writeFiles(drive, {
      'Novels/riverofclocks.epub': makeEpub({ title: 'River of Clocks' }),
      'Other/riverofclocks.pdf': makePdf({ pages: [{ text: textLines() }] }),
      'Novels/saltroadsongs.epub': makeEpub({ title: 'Salt Road Songs' }),
      'Other/saltroadsongs.pdf': makePdf({ pages: [{ text: textLines(40, 3) }] }),
    });
    await api.post('/api/folders', { path: drive });
    await scan();
    const rows = (await api.get('/api/review')).body.rows as {
      id: string;
      files: { name: string }[];
    }[];
    expect(rows).toHaveLength(2);
    const river = rows.find((r) => r.files[0]!.name.startsWith('river'))!;
    const salt = rows.find((r) => r.files[0]!.name.startsWith('salt'))!;
    await api.post(`/api/review/${river.id}`, { action: 'accept' });
    await api.post(`/api/review/${salt.id}`, { action: 'decline' });
    expect(itemIdOf('riverofclocks.epub')).toBe(itemIdOf('riverofclocks.pdf'));
    expect(itemIdOf('saltroadsongs.epub')).not.toBe(itemIdOf('saltroadsongs.pdf'));
    await scan();
    expect((await api.get('/api/review')).body.rows).toEqual([]);
    expect((await api.get('/api/state')).body.reviewOpen).toBe(0);
  });
});

describe('Library health', () => {
  it('lists unreadable files and archives that aren’t comics, kept apart', async () => {
    await addAndScan({
      'broken.epub': Buffer.from('not a zip'),
      'Comics/installer.zip': makeZip([
        { name: 'a.exe', data: Buffer.alloc(100, 1) },
        { name: 'b.dll', data: Buffer.alloc(100, 2) },
      ]),
      'fine.epub': makeEpub({ title: 'Fine' }),
    });
    const h = (await api.get('/api/health')).body;
    expect(h.errors.map((e: { name: string; problem: string }) => [e.name, e.problem])).toEqual([
      ['broken.epub', 'corrupt'],
    ]);
    expect(h.notComics.map((e: { name: string }) => e.name)).toEqual(['installer.zip']);
    expect((await api.get('/api/state')).body.healthProblems).toBe(2);
  });
});

describe('scan reminder (§9.7)', () => {
  it('reminds about a folder whose last complete scan is over 30 days old, and snoozes for 7 days', async () => {
    const folderId = await addAndScan({ 'a.epub': makeEpub({ title: 'A' }) });
    expect((await api.get('/api/reminders')).body).toEqual([]);
    const old = new Date(Date.now() - 34 * 86_400_000).toISOString();
    db.prepare('UPDATE folders SET last_complete_scan_at = ?').run(old);
    expect((await api.get('/api/reminders')).body).toEqual([
      expect.objectContaining({ folderId, days: 34, storageKind: 'external' }),
    ]);
    await api.post(`/api/folders/${folderId}/snooze-reminder`);
    expect((await api.get('/api/reminders')).body).toEqual([]);
  });

  it('a partial scan doesn’t reset the reminder', async () => {
    const folderId = await addAndScan({ 'Sub/a.epub': makeEpub({ title: 'A' }) });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    db.prepare('UPDATE folders SET last_complete_scan_at = ?').run(old);
    platform.failingDirs.add(path.join(drive, 'Sub'));
    await scan();
    expect((await api.get('/api/reminders')).body).toEqual([
      expect.objectContaining({ folderId, days: 40 }),
    ]);
  });
});

describe('backups', () => {
  it('include owner PDF-type corrections and review decisions, and restore a version-1 backup', async () => {
    const page = { image: makeImage(400, 615, 'jpeg', '#000', true), imageGray: true };
    await addAndScan({ 'g.pdf': makePdf({ pages: [page, page, page], width: 400, height: 615 }) });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    await api.patch(`/api/files/${fileId}`, { pdfTypeOverride: 'comic' });
    const backup = (await api.get('/api/backup')).body;
    expect(backup.tables.file_user).toHaveLength(1);
    // An M1 backup (version 1) has neither table, and none of the new columns.
    const v1 = structuredClone(backup);
    v1.schemaVersion = 1;
    delete v1.tables.file_user;
    delete v1.tables.review_items;
    for (const f of v1.tables.files)
      for (const k of [
        'metadata',
        'pdf_type',
        'pdf_type_evidence',
        'has_thumbnail',
        'problem',
        'problem_detail',
        'problem_at',
        'excluded',
      ])
        delete f[k];
    const r = await api.post('/api/restore', { backup: v1, confirm: true });
    expect(r.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM files').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM file_user').pluck().get()).toBe(0);
  });
});
