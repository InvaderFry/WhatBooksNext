import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import type { FakePlatform } from './platform/fake.ts';
import { makeEpub, makeM4b, makeMp3, makeWav } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Local audiobooks (docs/plans/audiobooks.md): audiobook folders, parts, listening time. */

const PORT = 4831;
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
  delete: (url: string) => request(made.app).delete(url).set('Host', HOST).send({}),
};

beforeEach(async () => {
  drive = tempDir('wbn-audio-drive-');
  dataDir = tempDir('wbn-audio-data-');
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

const items = async (query = '') =>
  (await api.get(`/api/items?limit=200${query}`)).body.items as {
    id: string;
    title: string;
    formats: string[];
    fileCount: number;
    listenMinutes: number | null;
    audioParts: number;
    media: { read: boolean; listen: boolean };
    creators: { name: string }[];
  }[];

const chapters = (album: string, n: number, seconds: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `${String(i + 1).padStart(2, '0')} - Chapter ${i + 1}.mp3`,
      makeMp3(seconds, { album, artist: 'Ann Author', title: `Chapter ${i + 1}` }),
    ]),
  );

const under = (dir: string, files: Record<string, Buffer>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v]));

describe('audiobook folders', () => {
  it('ignores audio until the owner says where the audiobooks are', async () => {
    writeFiles(drive, {
      'Music/Some Band - Song.mp3': makeMp3(60, { album: 'Some Album' }),
      'Books/a.epub': makeEpub({ title: 'A' }),
    });
    await api.post('/api/folders', { path: drive });
    const status = await scan();
    expect((await items()).map((i) => i.title)).toEqual(['A']);
    expect(status!.folders[0]!.ignoredByType.mp3).toBe(1);
  });

  it('lists audio as books only inside the audiobook folder, never the music beside it', async () => {
    writeFiles(drive, {
      'Music/Some Band - Song.mp3': makeMp3(60, { album: 'Some Album' }),
      ...under('Audiobooks/The Glass Orchard', chapters('The Glass Orchard', 3, 600)),
    });
    await api.post('/api/folders', { path: drive });
    const add = await api.post('/api/audiobook-folders', { path: path.join(drive, 'Audiobooks') });
    expect(add.body).toMatchObject({ dir: 'Audiobooks', newFolder: false });
    await scan();
    const all = await items();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      title: 'The Glass Orchard',
      formats: ['audio'],
      audioParts: 3,
      listenMinutes: 30,
      media: { read: false, listen: true },
    });
    expect(all[0]!.creators.map((c) => c.name)).toEqual(['Ann Author']);
    const folders = (await api.get('/api/folders')).body;
    expect(folders[0].audiobookDirs).toEqual(['Audiobooks']);
  });

  it('adds an audiobook folder from somewhere new as a library folder of its own', async () => {
    writeFiles(drive, { 'The Salt Road.m4b': makeM4b(7200, { album: 'The Salt Road' }) });
    const add = await api.post('/api/audiobook-folders', { path: drive });
    expect(add.body).toMatchObject({ dir: '', newFolder: true });
    await scan();
    expect(await items()).toMatchObject([{ title: 'The Salt Road', listenMinutes: 120 }]);
    expect((await api.post('/api/audiobook-folders', { path: drive })).status).toBe(409);
  });

  it('drops the audio, and keeps the ebook, when the folder stops holding audiobooks', async () => {
    writeFiles(drive, {
      'The Salt Road.m4b': makeM4b(7200, { album: 'The Salt Road' }),
      'The Salt Road.epub': makeEpub({ title: 'The Salt Road' }),
      'Only Heard.m4b': makeM4b(600, { album: 'Only Heard' }),
    });
    const add = await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    expect((await items()).map((i) => i.title).sort()).toEqual(['Only Heard', 'The Salt Road']);
    const r = await api.delete(`/api/folders/${add.body.folderId}/audiobooks?dir=`);
    expect(r.body).toMatchObject({ ok: true, itemsRemoved: 1 });
    await scan();
    expect(await items()).toMatchObject([
      { title: 'The Salt Road', formats: ['epub'], media: { read: true, listen: false } },
    ]);
  });
});

describe('one audiobook from many files', () => {
  it('joins the discs of a book and adds their playing times up', async () => {
    writeFiles(drive, {
      ...under('The Glass Orchard/CD 1', chapters('The Glass Orchard', 2, 300)),
      ...under('The Glass Orchard/CD 2', chapters('The Glass Orchard', 2, 300)),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    expect(await items()).toMatchObject([
      { title: 'The Glass Orchard', audioParts: 4, listenMinutes: 20 },
    ]);
  });

  it('counts each part once when the whole book is copied to a second place', async () => {
    const book = chapters('The Glass Orchard', 3, 600);
    writeFiles(drive, {
      ...under('A/The Glass Orchard', book),
      ...under('B/The Glass Orchard', book),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    expect(await items()).toMatchObject([{ fileCount: 6, audioParts: 3, listenMinutes: 30 }]);
  });

  it('names an untagged book by its folder and still measures it', async () => {
    writeFiles(drive, {
      'Bo Writer - The Salt Road/Track 01.wav': makeWav(60),
      'Bo Writer - The Salt Road/Track 02.wav': makeWav(120),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    const [book] = await items();
    expect(book).toMatchObject({ audioParts: 2, listenMinutes: 3 });
    expect(book!.title).toMatch(/Salt Road/);
  });

  it('keeps the playing time unknown when one part can’t be read', async () => {
    writeFiles(drive, {
      'The Salt Road/01 Start.mp3': makeMp3(600, { album: 'The Salt Road' }),
      'The Salt Road/02 Broken.mp3': Buffer.from('not audio at all'),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    expect(await items()).toMatchObject([{ audioParts: 2, listenMinutes: null }]);
  });

  it('lists an old Audible .aa file with an unknown length rather than a made-up one', async () => {
    writeFiles(drive, { 'The Salt Road.aa': Buffer.alloc(4000, 7) });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    expect(await items()).toMatchObject([
      { title: 'The Salt Road', formats: ['audio'], listenMinutes: null },
    ]);
  });

  it('adds a new part to its book on the next scan', async () => {
    writeFiles(drive, under('The Glass Orchard', chapters('The Glass Orchard', 2, 600)));
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    const before = await items();
    writeFiles(drive, {
      'The Glass Orchard/03 - Chapter 3.mp3': makeMp3(600, { album: 'The Glass Orchard' }),
    });
    await scan();
    const after = await items();
    expect(after).toMatchObject([{ id: before[0]!.id, audioParts: 3, listenMinutes: 30 }]);
  });
});

describe('one book, two ways', () => {
  it('puts an audiobook and the ebook beside it under one book, opened as the ebook', async () => {
    writeFiles(drive, {
      'The Salt Road.m4b': makeM4b(7200, { album: 'The Salt Road', artist: 'Bo Writer' }),
      'The Salt Road.epub': makeEpub({ title: 'The Salt Road', chapters: [3000] }),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
    const all = await items();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ media: { read: true, listen: true }, listenMinutes: 120 });
    const page = (await api.get(`/api/items/${all[0]!.id}`)).body;
    expect(page.files.find((f: { isPrimary: boolean }) => f.isPrimary).format).toBe('epub');
  });
});

describe('What next: read, listen or either', () => {
  beforeEach(async () => {
    writeFiles(drive, {
      'Heard Only.m4b': makeM4b(3000, { album: 'Heard Only' }),
      'Read Only.epub': makeEpub({ title: 'Read Only', chapters: [3000] }),
      'Both Ways.m4b': makeM4b(36000, { album: 'Both Ways' }),
      'Both Ways.epub': makeEpub({ title: 'Both Ways', chapters: [3000] }),
    });
    await api.post('/api/audiobook-folders', { path: drive });
    await scan();
  });

  const picks = async (query: string) =>
    (await api.get(`/api/next?${query}`)).body as {
      cards: { title: string; scope: string; listen: string | null; fit: string }[];
      mightFit?: { title: string }[];
      situation: { medium: string };
    };

  it('offers everything by default, an audiobook by its playing time', async () => {
    const r = await picks('');
    expect(r.situation.medium).toBe('either');
    expect(r.cards.map((p) => p.title).sort()).toEqual(['Both Ways', 'Heard Only', 'Read Only']);
    expect(r.cards.find((p) => p.title === 'Heard Only')!.scope).toBe(
      'Whole book · 50 min to listen',
    );
    expect(r.cards.find((p) => p.title === 'Both Ways')!.listen).toBe('Or listen: 10 h');
    expect(r.cards.find((p) => p.title === 'Read Only')!.listen).toBeNull();
  });

  it('shows only audiobooks for Listen, and only things to read for Read', async () => {
    expect((await picks('medium=listen')).cards.map((p) => p.title).sort()).toEqual([
      'Both Ways',
      'Heard Only',
    ]);
    expect((await picks('medium=read')).cards.map((p) => p.title).sort()).toEqual([
      'Both Ways',
      'Read Only',
    ]);
  });

  it('fits Listen by the playing time, not the reading time', async () => {
    const r = await picks('medium=listen&time=60&mode=finish_within');
    expect(r.cards.find((p) => p.title === 'Heard Only')!.fit).toBe('fits');
    // Ten hours of listening doesn't fit an hour, however short the ebook is.
    expect(r.cards.find((p) => p.title === 'Both Ways')?.fit ?? 'left out').not.toBe('fits');
  });
});

describe('Audible as a store', () => {
  it('adds an Audible audiobook by hand with its length, to listen to', async () => {
    const r = await api.post('/api/store/items', {
      store: 'audible',
      title: 'The Salt Road',
      author: 'Bo Writer',
      listenMinutes: 552,
      url: 'https://www.audible.com/webplayer?asin=B000000000',
    });
    expect(r.status).toBe(200);
    const [book] = await items();
    expect(book).toMatchObject({ media: { read: false, listen: true }, listenMinutes: 552 });
    const page = (await api.get(`/api/items/${r.body.itemId}`)).body;
    // Not ticked as playable there yet, so the link is offered but it isn't "ready".
    expect(page.availability.storeLinks).toMatchObject([{ store: 'audible', kind: 'read' }]);
    expect(page.availability.readyToRead).toBe(false);
    expect((await items('&store=audible')).map((i) => i.title)).toEqual(['The Salt Road']);
  });

  it('refuses a listening length on a store that isn’t Audible, and a link that isn’t Audible’s', async () => {
    expect(
      (await api.post('/api/store/items', { store: 'kindle', title: 'X', listenMinutes: 60 }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.post('/api/store/items', {
          store: 'audible',
          title: 'X',
          url: 'https://example.com/webplayer',
        })
      ).status,
    ).toBe(400);
  });
});
