import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { makeEpub, makeM4b, makeMp3, makeWav } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

const PORT = 4832;
const HOST = `localhost:${PORT}`;
let db: DB;
let drive: string;
let dataDir: string;
let made: ReturnType<typeof createApp>;
const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object) => request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
  delete: (url: string) => request(made.app).delete(url).set('Host', HOST).send({}),
};
beforeEach(async () => {
  db = await memoryDb();
  drive = tempDir('wbn-review-drive-');
  dataDir = tempDir('wbn-review-data-');
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir,
    snapshotDir: null,
    autoLookups: false,
  });
});
afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function scan(files: Record<string, Buffer>) {
  writeFiles(drive, files);
  const folder = await api.post('/api/audiobook-folders', { path: drive });
  await api.post('/api/scan', {});
  await made.scans.wait();
  return folder.body.folderId as string;
}
const books = async () =>
  (await api.get('/api/items')).body.items as {
    id: string;
    title: string;
    fileCount: number;
    listenMinutes: number | null;
    listenBasis: string | null;
    audioParts: number;
  }[];

describe('audiobook review regressions', () => {
  it('does not leave fully read audio waiting for a full hash it will never get', async () => {
    await scan({
      'The Glass Orchard.m4b': makeM4b(600),
      'The Salt Road.epub': makeEpub({ title: 'The Salt Road' }),
    });
    expect((await api.get('/api/health')).body).toMatchObject({ notYetHashed: 0, notYetRead: 0 });
    db.prepare("UPDATE files SET full_hash = NULL WHERE format = 'epub'").run();
    expect((await api.get('/api/health')).body.notYetHashed).toBe(1);
  });

  it('includes unread audio in health, but not missing files or files with a recorded error', async () => {
    await scan({ 'The Glass Orchard.m4b': makeM4b(600) });
    db.prepare("UPDATE files SET stages = '{}' WHERE format = 'audio'").run();
    expect((await api.get('/api/health')).body.notYetRead).toBe(1);
    db.prepare("UPDATE files SET problem = 'corrupt'").run();
    expect((await api.get('/api/health')).body.notYetRead).toBe(0);
    db.prepare("UPDATE files SET problem = NULL, availability = 'missing'").run();
    expect((await api.get('/api/health')).body.notYetRead).toBe(0);
  });

  it.each([false, true])(
    'does not join different books through identical credits (later scan: %s)',
    async (later) => {
      const credits = makeMp3(1);
      const first = {
        'The Glass Orchard/CD 1/Credits.mp3': credits,
        'The Glass Orchard/CD 1/01 Start.mp3': makeMp3(2, { album: 'The Glass Orchard' }),
      };
      const second = {
        'The Salt Road/CD 1/Credits.mp3': credits,
        'The Salt Road/CD 1/01 Start.mp3': makeMp3(3, { album: 'The Salt Road' }),
      };
      await scan(later ? first : { ...first, ...second });
      if (later) {
        writeFiles(drive, second);
        await api.post('/api/scan', {});
        await made.scans.wait();
      }
      expect(
        (await books())
          .map((b) => ({ title: b.title, files: b.fileCount }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      ).toEqual([
        { title: 'The Glass Orchard', files: 2 },
        { title: 'The Salt Road', files: 2 },
      ]);
    },
  );

  it('keeps numeric titles and numbered MP3 books separate through a complete scan', async () => {
    await scan(
      Object.fromEntries(
        ['4027', '13-24-57', 'Lantern Saga 3', 'Lantern Saga 4'].map((title) => [
          `Books/${title}.mp3`,
          makeMp3(1),
        ]),
      ),
    );
    const titles = (await books()).map((b) => b.title);
    expect(titles).toHaveLength(4);
    expect(titles).toEqual(
      expect.arrayContaining(['4027', '13 24 57', 'Lantern Saga 3', 'Lantern Saga 4']),
    );
  });

  it.each([false, true])(
    'uses the stated Audible length when local audio is incomplete (parts: %s)',
    async (parts) => {
      await scan(
        parts
          ? {
              'The Glass Orchard/01 Start.mp3': makeMp3(60, { album: 'The Glass Orchard' }),
              'The Glass Orchard/02 End.mp3': Buffer.from('broken'),
            }
          : { 'The Glass Orchard.aa': Buffer.from('unreadable legacy audio') },
      );
      const [book] = await books();
      await api.post(`/api/items/${book!.id}/locations`, { store: 'audible', listenMinutes: 552 });
      expect(await books()).toMatchObject([
        { listenMinutes: 552, listenBasis: 'as Audible states' },
      ]);
    },
  );

  it('prefers a complete local playing time over the stated store length', async () => {
    await scan({ 'The Glass Orchard.m4b': makeM4b(600) });
    const [book] = await books();
    await api.post(`/api/items/${book!.id}/locations`, { store: 'audible', listenMinutes: 552 });
    expect(await books()).toMatchObject([
      { listenMinutes: 10, listenBasis: 'from the audio file' },
    ]);
  });

  it('edits and clears an Audible length without removing its link or readability', async () => {
    const created = await api.post('/api/store/items', {
      store: 'audible',
      title: 'The Glass Orchard',
      listenMinutes: 552,
      readable: true,
      url: 'https://www.audible.com/webplayer?asin=B000000001',
    });
    const id = created.body.itemId as string;
    const [place] = (await api.get(`/api/items/${id}/locations`)).body;
    expect((await api.patch(`/api/locations/${place.id}`, { listenMinutes: 600 })).status).toBe(
      200,
    );
    expect(await books()).toMatchObject([{ listenMinutes: 600 }]);
    expect((await api.patch(`/api/locations/${place.id}`, { listenMinutes: null })).status).toBe(
      200,
    );
    expect(await books()).toMatchObject([{ listenMinutes: null, listenBasis: null }]);
    expect((await api.get(`/api/items/${id}/locations`)).body).toMatchObject([
      {
        readable: true,
        url: 'https://www.audible.com/webplayer?asin=B000000001',
        listenMinutes: null,
      },
    ]);
  });

  it('distinguishes an omitted length from an explicit clear when adding an existing store copy', async () => {
    const created = await api.post('/api/store/items', {
      store: 'audible',
      title: 'The Glass Orchard',
      listenMinutes: 552,
    });
    const url = `/api/items/${created.body.itemId}/locations`;
    await api.post(url, { store: 'audible' });
    expect(await books()).toMatchObject([{ listenMinutes: 552 }]);
    await api.post(url, { store: 'audible', listenMinutes: null });
    expect(await books()).toMatchObject([{ listenMinutes: null }]);
  });

  it('rejects invalid length updates atomically and refuses a length on another store', async () => {
    const created = await api.post('/api/store/items', {
      store: 'audible',
      title: 'The Glass Orchard',
      listenMinutes: 552,
    });
    const [audible] = (await api.get(`/api/items/${created.body.itemId}/locations`)).body;
    for (const length of [-1, 0, 1.5, 60001, 'unknown']) {
      expect(
        (await api.patch(`/api/locations/${audible.id}`, { listenMinutes: length, readable: true }))
          .status,
      ).toBe(400);
    }
    expect((await api.get(`/api/items/${created.body.itemId}/locations`)).body).toMatchObject([
      { readable: false, listenMinutes: 552 },
    ]);
    const kobo = await api.post(`/api/items/${created.body.itemId}/locations`, { store: 'kobo' });
    expect(
      (await api.patch(`/api/locations/${kobo.body.id}`, { listenMinutes: null })).status,
    ).toBe(400);
  });

  it('removes covers of deleted audio files while keeping other covers and every library file', async () => {
    writeFiles(drive, {
      'Audio/The Glass Orchard.m4b': makeM4b(600),
      'Keep/The Salt Road.wav': makeWav(1),
      'Reading/The Paper Trail.epub': makeEpub({ title: 'The Paper Trail', cover: true }),
    });
    await api.post('/api/folders', { path: drive });
    const folder = await api.post('/api/audiobook-folders', { path: path.join(drive, 'Audio') });
    await api.post('/api/audiobook-folders', { path: path.join(drive, 'Keep') });
    await api.post('/api/scan', {});
    await made.scans.wait();
    const files = db.prepare('SELECT id, rel_path FROM files').all() as {
      id: string;
      rel_path: string;
    }[];
    const covers = path.join(dataDir, 'covers');
    fs.mkdirSync(covers, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(covers, `${file.id}.jpg`), 'test cover');
    expect(
      (await api.delete(`/api/folders/${folder.body.folderId}/audiobooks?dir=Audio`)).status,
    ).toBe(200);
    for (const file of files) {
      expect(fs.existsSync(path.join(covers, `${file.id}.jpg`))).toBe(
        !file.rel_path.startsWith('Audio/'),
      );
      expect(fs.existsSync(path.join(drive, file.rel_path))).toBe(true);
    }
  });
});
