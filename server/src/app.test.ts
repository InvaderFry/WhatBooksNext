import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { listTables, type DB } from './db/database.ts';
import { BACKUP_EXCLUDED, BACKUP_TABLES } from './lib/backup.ts';
import type { FakePlatform } from './platform/fake.ts';
import { ATTR_RECALL_ON_DATA_ACCESS } from './platform/types.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

const PORT = 4818;
const HOST = `localhost:${PORT}`;

let db: DB;
let drive: string;
let platform: FakePlatform;
let snapshots: string;
let made: ReturnType<typeof createApp>;

/** A request as the app's own page would send it. */
const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
  delete: (url: string) =>
    request(made.app).delete(url).set('Host', HOST).set('Content-Type', 'application/json'),
};

async function freshApp() {
  await made?.close();
  db = await memoryDb();
  made = createApp({
    db,
    platform,
    port: PORT,
    dataDir: null,
    snapshotDir: snapshots,
    autoLookups: false,
  });
}

beforeEach(async () => {
  drive = tempDir('wbn-app-drive-');
  snapshots = tempDir('wbn-app-snap-');
  platform = fakePlatformWithDrives({ drive });
  await freshApp();
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
  fs.rmSync(snapshots, { recursive: true, force: true });
});

async function addAndScan(files: Record<string, number>) {
  writeFiles(drive, files);
  const add = await api.post('/api/folders', { path: drive });
  expect(add.status).toBe(200);
  await api.post('/api/scan', {});
  await made.scans.wait();
  return add.body.id as string;
}

async function itemByTitle(title: string) {
  const r = await api.get(`/api/items?q=${encodeURIComponent(title)}`);
  return r.body.items[0] as { id: string; title: string; user: Record<string, unknown> };
}

describe('scenario 21: requests from another website are refused', () => {
  it('refuses a request with a foreign Host header (DNS rebinding)', async () => {
    const r = await request(made.app).get('/api/items').set('Host', 'attacker.example:4818');
    expect(r.status).toBe(403);
  });

  it('refuses a state-changing request with a foreign Origin, including Open', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    const r = await request(made.app)
      .post(`/api/files/${fileId}/open`)
      .set('Host', HOST)
      .set('Origin', 'https://attacker.example')
      .send({});
    expect(r.status).toBe(403);
    expect(platform.opened).toEqual([]);
  });

  it('refuses a state-changing request that is not JSON (a plain form post skips the preflight)', async () => {
    const r = await request(made.app)
      .post('/api/scan')
      .set('Host', HOST)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('a=1');
    expect(r.status).toBe(415);
    const multipart = await request(made.app)
      .post('/api/restore')
      .set('Host', HOST)
      .field('backup', '{}');
    expect(multipart.status).toBe(415);
  });

  it('never sends CORS headers and refuses preflights', async () => {
    const r = await request(made.app)
      .options('/api/scan')
      .set('Host', HOST)
      .set('Origin', 'https://attacker.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("accepts the app's own origin", async () => {
    const r = await request(made.app)
      .post('/api/scan/cancel')
      .set('Host', HOST)
      .set('Origin', `http://${HOST}`)
      .send({});
    expect(r.status).toBe(200);
  });

  it('allows the Vite dev server only when started in development', async () => {
    const prod = await request(made.app).get('/api/state').set('Host', 'localhost:5173');
    expect(prod.status).toBe(403);
    const dev = createApp({
      db,
      platform,
      port: PORT,
      devPorts: [5173],
      dataDir: null,
      snapshotDir: null,
    });
    const ok = await request(dev.app).get('/api/state').set('Host', 'localhost:5173');
    expect(ok.status).toBe(200);
  });
});

describe('folders', () => {
  it('refuses a folder that does not exist', async () => {
    const r = await api.post('/api/folders', { path: path.join(drive, 'nope') });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/can't be found/);
  });

  it('marks a folder "Also in iCloud", which makes its items ready to read with the drive unplugged', async () => {
    const id = await addAndScan({ 'mapmaking.epub': 10 });
    platform.volumes[0]!.root = null;
    let item = (await api.get('/api/items?ready=1')).body;
    expect(item.total).toBe(0);
    await api.patch(`/api/folders/${id}`, { alsoInICloud: true });
    item = (await api.get('/api/items?ready=1')).body;
    expect(item.total).toBe(1);
    expect(item.items[0].availability).toMatchObject({
      state: 'not_connected',
      label: 'On external drive (not connected)',
      alsoInICloud: true,
    });
  });

  it('lets one item say it is not in iCloud even though its folder is', async () => {
    const id = await addAndScan({ 'mapmaking.epub': 10 });
    await api.patch(`/api/folders/${id}`, { alsoInICloud: true });
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, { icloudOverride: 'not_in' });
    expect((await itemByTitle('mapmaking')) as unknown).toMatchObject({
      availability: { alsoInICloud: false },
    });
  });

  it('removing a folder keeps items the owner has recorded something on', async () => {
    const id = await addAndScan({ 'mapmaking.epub': 10, 'glassharbor.epub': 20 });
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, { rating: 7 });
    const r = await api.delete(`/api/folders/${id}`);
    expect(r.body.itemsRemoved).toBe(1);
    expect((await api.get(`/api/items/${item.id}`)).body.user.rating).toBe(7);
  });
});

describe('progress and owner data (§13.6)', () => {
  beforeEach(async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
  });

  it('records today as the start date when reading starts', async () => {
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, { progress: 'into_it' });
    const u = (await api.get(`/api/items/${item.id}`)).body.user;
    expect(u).toMatchObject({ progress: 'into_it', startedPrecision: 'exact' });
    expect(u.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps an unknown finish date unknown — never today (scenario 6, data level)', async () => {
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, {
      progress: 'finished',
      finishedPrecision: 'unknown',
    });
    const u = (await api.get(`/api/items/${item.id}`)).body.user;
    expect(u).toMatchObject({
      progress: 'finished',
      finishedOn: null,
      finishedPrecision: 'unknown',
    });
  });

  it('keeps an approximate date and its precision', async () => {
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, {
      progress: 'finished',
      finishedOn: '2019-06',
      finishedPrecision: 'approximate',
    });
    expect((await api.get(`/api/items/${item.id}`)).body.user).toMatchObject({
      finishedOn: '2019-06',
      finishedPrecision: 'approximate',
    });
  });

  it('refuses dates that look right but are not on the calendar', async () => {
    const item = await itemByTitle('mapmaking');
    for (const finishedOn of ['2026-99-99', '2026-02-30', '2025-02-29', '2024-13', '2024-00-10']) {
      const r = await api.patch(`/api/items/${item.id}`, { progress: 'finished', finishedOn });
      expect(r.status, finishedOn).toBe(400);
    }
    expect((await api.get(`/api/items/${item.id}`)).body.user.progress).toBe('not_started');
    expect(
      (await api.patch(`/api/items/${item.id}`, { progress: 'finished', finishedOn: '2024-02-29' }))
        .status,
    ).toBe(200);
  });

  it('refuses an exact date that names only a month or year, and calls a bare month approximate', async () => {
    const item = await itemByTitle('mapmaking');
    const r = await api.patch(`/api/items/${item.id}`, {
      progress: 'finished',
      finishedOn: '2019',
      finishedPrecision: 'exact',
    });
    expect(r.status).toBe(400);
    expect(
      (await api.patch(`/api/items/${item.id}`, { progress: 'into_it', startedOn: '2019-06' }))
        .status,
    ).toBe(200);
    expect((await api.get(`/api/items/${item.id}`)).body.user).toMatchObject({
      startedOn: '2019-06',
      startedPrecision: 'approximate',
    });
  });

  it('takes an optional DNF reason and clears it when the book is restored', async () => {
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, { progress: 'dnf', dnfReason: 'not_now' });
    expect((await api.get(`/api/items/${item.id}`)).body.user.dnfReason).toBe('not_now');
    await api.patch(`/api/items/${item.id}`, { progress: 'not_started' });
    expect((await api.get(`/api/items/${item.id}`)).body.user.dnfReason).toBeNull();
  });

  it('refuses a rating outside 1–10 and unknown fields', async () => {
    const item = await itemByTitle('mapmaking');
    expect((await api.patch(`/api/items/${item.id}`, { rating: 11 })).status).toBe(400);
    expect((await api.patch(`/api/items/${item.id}`, { stars: 3 })).status).toBe(400);
  });

  it("lets the owner fix the title and kind, and a later scan doesn't undo it", async () => {
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, {
      titleOverride: 'The Mapmaking Book',
      kindOverride: 'nonfiction',
    });
    await api.post('/api/scan', {});
    await made.scans.wait();
    const after = (await api.get(`/api/items/${item.id}`)).body;
    expect(after).toMatchObject({
      title: 'The Mapmaking Book',
      kind: 'nonfiction',
      factTitle: 'Map Making',
    });
  });
});

describe('shortlist (§13.9)', () => {
  it('keeps an ordered queue that can be reordered', async () => {
    await addAndScan({ 'a/alpha.epub': 1, 'b/bravo.epub': 2, 'c/charlie.epub': 3 });
    const ids = await Promise.all(
      ['alpha', 'bravo', 'charlie'].map(async (t) => (await itemByTitle(t)).id),
    );
    for (const id of ids) await api.post('/api/shortlist', { itemId: id });
    await api.post('/api/shortlist/move', { itemId: ids[2], direction: 'up' });
    const titles = (await api.get('/api/shortlist')).body.map((i: { title: string }) => i.title);
    expect(titles).toEqual(['Alpha', 'Charlie', 'Bravo']);
    await api.delete(`/api/shortlist/${ids[0]}`);
    const after = (await api.get('/api/shortlist')).body.map(
      (i: { user: { shortlistPosition: number } }) => i.user.shortlistPosition,
    );
    expect(after).toEqual([1, 2]);
  });
});

describe('Open and Show in folder (§14)', () => {
  it('opens a present file by id', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    expect((await api.post(`/api/files/${fileId}/open`)).status).toBe(200);
    expect(platform.opened).toEqual([{ action: 'open', path: path.join(drive, 'mapmaking.epub') }]);
  });

  it('asks before opening an online-only file, re-checking it at that moment', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    // Freed up after the scan: the stored state says present, the re-check says placeholder.
    platform.attributes.set(path.join(drive, 'mapmaking.epub'), 0x20 | ATTR_RECALL_ON_DATA_ACCESS);
    const r = await api.post(`/api/files/${fileId}/open`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ needsConfirmation: true });
    expect(platform.opened).toEqual([]);
    expect((await api.post(`/api/files/${fileId}/open`, { confirmDownload: true })).status).toBe(
      200,
    );
  });

  it('says plainly when the drive is not connected', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const fileId = db.prepare('SELECT id FROM files').pluck().get() as string;
    platform.volumes[0]!.root = null;
    const r = await api.post(`/api/files/${fileId}/show`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not connected/);
  });

  it('only accepts a file id — a path in the URL finds nothing', async () => {
    const r = await api.post(`/api/files/${encodeURIComponent('C:\\Windows\\notepad.exe')}/open`);
    expect(r.status).toBe(404);
  });
});

describe('backup and restore (§16)', () => {
  it('covers every table: each is in the backup or on the commented exclusion list', () => {
    const covered = new Set<string>([...BACKUP_TABLES, ...Object.keys(BACKUP_EXCLUDED)]);
    expect(listTables(db).filter((t) => !covered.has(t))).toEqual([]);
  });

  it('scenario 14: backup → empty app → restore recovers everything with no drive connected; a later scan reconnects files without changing ids', async () => {
    await addAndScan({
      'Novels/mapmaking.epub': 10,
      'Novels/mapmaking.pdf': 30,
      'Comics/lanternfish_vol1.cbz': 40,
    });
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, {
      progress: 'halfway',
      rating: 9,
      note: 'Good so far',
      titleOverride: 'Mapmaking!',
    });
    await api.post('/api/shortlist', { itemId: item.id });
    const backup = (await api.get('/api/backup')).body;
    expect(backup.note).toMatch(/API keys/);

    platform.volumes[0]!.root = null; // drive unplugged
    await freshApp(); // empty app
    expect((await api.get('/api/items')).body.total).toBe(0);

    const preview = await api.post('/api/restore/preview', { backup });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.find((c: { table: string }) => c.table === 'items')).toMatchObject({
      inBackup: 2,
      now: 0,
    });
    expect((await api.post('/api/restore', { backup, confirm: true })).status).toBe(200);

    const restored = (await api.get(`/api/items/${item.id}`)).body;
    expect(restored).toMatchObject({
      title: 'Mapmaking!',
      user: { progress: 'halfway', rating: 9, note: 'Good so far', shortlistPosition: 1 },
    });
    expect(restored.availability.label).toBe('On external drive (not connected)');

    platform.volumes[0]!.root = path.resolve(drive); // plugged back in
    await api.post('/api/scan', {});
    await made.scans.wait();
    const after = (await api.get(`/api/items/${item.id}`)).body;
    expect(after.availability.state).toBe('present');
    expect(after.files.map((f: { id: string }) => f.id).sort()).toEqual(
      restored.files.map((f: { id: string }) => f.id).sort(),
    );
    expect((await api.get('/api/items')).body.total).toBe(2);
  });

  it('rolls a corrupt restore back, leaving the data as it was', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const item = await itemByTitle('mapmaking');
    await api.patch(`/api/items/${item.id}`, { rating: 5 });
    const backup = (await api.get('/api/backup')).body;
    backup.tables.user_item[0].rating = 99; // violates the 1–10 check, in the last table applied
    backup.tables.items.push({ ...backup.tables.items[0], id: 'extra-item', title: 'Extra' });
    const r = await api.post('/api/restore', { backup, confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nothing was changed/);
    expect((await api.get('/api/items')).body.total).toBe(1);
    expect((await api.get(`/api/items/${item.id}`)).body.user.rating).toBe(5);
  });

  it("refuses a file that isn't a backup, and one with unknown columns", async () => {
    expect((await api.post('/api/restore/preview', { backup: { hello: 1 } })).status).toBe(400);
    const backup = (await api.get('/api/backup')).body;
    backup.tables.items.push({ id: 'x', title: 't', evil: 1 });
    const r = await api.post('/api/restore/preview', { backup });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown column/);
  });

  it('takes a pre-restore snapshot first', async () => {
    const backup = (await api.get('/api/backup')).body;
    const r = await api.post('/api/restore', { backup, confirm: true });
    expect(fs.existsSync(r.body.snapshotPath)).toBe(true);
    expect(path.basename(r.body.snapshotPath)).toMatch(/^pre-restore-/);
  });
});

describe('diagnostics', () => {
  it('leaves folder names out unless asked', async () => {
    await addAndScan({ 'mapmaking.epub': 10 });
    const plain = (await api.get('/api/diagnostics')).body;
    expect(JSON.stringify(plain)).not.toContain(drive);
    expect(plain.folders[0]).toMatchObject({
      name: 'Folder 1',
      reachable: true,
      files: { present: 1 },
    });
    const named = (await api.get('/api/diagnostics?names=1')).body;
    expect(named.folders[0].name).toBe(path.resolve(drive));
  });
});
