import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import type { Fetcher } from './sources/types.ts';
import { makeCbz } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Comic issue lookups (M4: Metron, then ComicVine as fallback), through the app. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;
const DIR = path.join(import.meta.dirname, '..', '..', 'fixtures', 'sources', 'synthetic');
const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as unknown;

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;
let paths: string[];

const NONE = { count: 0, next: null, previous: null, results: [] };

/** When set, Metron also has #3 in both invented runs (2019 and 2023). */
let metronHasThree = false;
const issueThree = () => {
  const two = fixture('metron-issues-copperline-2.json') as { results: Record<string, unknown>[] };
  return {
    ...two,
    results: two.results.map((r) => ({ ...r, id: Number(r.id) + 1, number: '3' })),
  };
};

const fetcher: Fetcher = async (url) => {
  const u = new URL(url);
  paths.push(`${u.hostname}${u.pathname}`);
  let body: unknown = { status_code: 101, error: 'Object Not Found', results: [] };
  if (u.hostname === 'metron.cloud') {
    if (u.pathname === '/api/issue/')
      body =
        u.searchParams.get('number') === '2'
          ? fixture('metron-issues-copperline-2.json')
          : u.searchParams.get('number') === '3' && metronHasThree
            ? issueThree()
            : NONE;
    else if (u.pathname === '/api/series/9001/') body = fixture('metron-series-9001.json');
    else if (u.pathname === '/api/series/9002/') body = fixture('metron-series-9002.json');
  } else if (u.hostname === 'comicvine.gamespot.com') {
    if (u.pathname === '/api/volumes/') body = fixture('comicvine-volumes-copperline.json');
    else if (u.pathname === '/api/issues/') body = fixture('comicvine-issues-copperline-2.json');
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  put: (url: string, body: object) => request(made.app).put(url).set('Host', HOST).send(body),
};

const issue = (n: number) =>
  makeCbz({ pages: 4, comicInfo: { Series: 'Copperline', Number: String(n), Year: '2019' } });

beforeEach(async () => {
  drive = tempDir('wbn-m4-comics-');
  paths = [];
  metronHasThree = false;
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
  // Tests don't wait out the real politeness gaps (3.1 s and 18.5 s).
  for (const c of [made.sources.metron.client, made.sources.comicvine.client])
    (c as unknown as { minInterval: number }).minInterval = 0;
  writeFiles(drive, {
    'Copperline/Copperline 002 (2019).cbz': issue(2),
    'Copperline/Copperline 003 (2019).cbz': issue(3),
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

async function lookUp() {
  made.lookups.start();
  await made.lookups.wait();
}

describe('comic issue lookups', () => {
  it('leaves single issues alone until a comic source is set up', async () => {
    await lookUp();
    expect(paths).toEqual([]);
  });

  it('identifies an issue on Metron by series, number and year, and learns the series has ended', async () => {
    expect((await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' })).status).toBe(
      200,
    );
    await lookUp();
    const two = itemOf('Copperline 002 (2019).cbz');
    expect(db.prepare('SELECT identity, match_source FROM items WHERE id = ?').get(two)).toEqual({
      identity: 'accepted',
      match_source: 'metron',
    });
    const s = db
      .prepare(
        'SELECT s.publication_status, s.installments, s.status_source FROM series s JOIN items i ON i.series_id = s.id WHERE i.id = ?',
      )
      .get(two);
    expect(s).toEqual({ publication_status: 'finished', installments: 6, status_source: 'metron' });
  });

  it('asks ComicVine only for the issue Metron couldn’t find', async () => {
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    await api.put('/api/settings/comicvine', { token: 'cvkey0123456789abcdef' });
    await lookUp();
    const state = (name: string) =>
      db
        .prepare('SELECT source, outcome FROM lookup_state WHERE item_id = ? ORDER BY source')
        .all(itemOf(name));
    expect(state('Copperline 002 (2019).cbz')).toEqual([
      { source: 'comicvine', outcome: 'skipped' },
      { source: 'metron', outcome: 'matched' },
    ]);
    // Metron has no #3 here; ComicVine is asked (and has no #3 either).
    expect(state('Copperline 003 (2019).cbz')).toEqual([
      { source: 'comicvine', outcome: 'none' },
      { source: 'metron', outcome: 'none' },
    ]);
    expect(paths.filter((p) => p.startsWith('comicvine'))).toHaveLength(2);
    // A second run asks nothing new.
    paths = [];
    await lookUp();
    expect(paths).toEqual([]);
  });

  it('keeps the keys out of Diagnostics and settings answers', async () => {
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    const s = (await api.get('/api/settings/metron')).body;
    expect(s).toMatchObject({ configured: true, masked: '••••cdef' });
    expect(JSON.stringify((await api.get('/api/diagnostics')).body)).not.toContain(
      'tok-1234567890',
    );
    expect(JSON.stringify((await api.get('/api/backup')).body)).not.toContain('tok-1234567890');
  });

  it('tests Metron from Diagnostics with titles left out', async () => {
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    const r = (await api.post('/api/diagnostics/comic-test', { source: 'metron' })).body;
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('Copperline');
  });

  it('takes the run from a year in the folder name when the file gives none', async () => {
    metronHasThree = true;
    writeFiles(drive, {
      'Copperline (2023)/Copperline 003.cbz': makeCbz({
        pages: 4,
        comicInfo: { Series: 'Copperline', Number: '3' },
      }),
    });
    await api.post('/api/scan', {});
    await made.scans.wait();
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    await lookUp();
    const id = itemOf('Copperline 003.cbz');
    expect(db.prepare('SELECT identity, match_source_id FROM items WHERE id = ?').get(id)).toEqual({
      identity: 'accepted',
      match_source_id: '900103',
    });
  });

  it('settles an issue with no year by the run of the issues next to it', async () => {
    metronHasThree = true;
    const plain = (n: number, year?: string) =>
      makeCbz({
        pages: 4,
        comicInfo: { Series: 'Copperline', Number: String(n), ...(year ? { Year: year } : {}) },
      });
    writeFiles(drive, {
      'Run/Copperline 012 two.cbz': plain(2, '2019'),
      'Run/Copperline 013 three.cbz': plain(3),
    });
    await api.post('/api/scan', {});
    await made.scans.wait();
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    await lookUp();
    const three = itemOf('Copperline 013 three.cbz');
    expect(
      db.prepare('SELECT identity, match_source_id FROM items WHERE id = ?').get(three),
    ).toEqual({
      identity: 'accepted',
      match_source_id: '900003',
    });
  });

  it('leaves two runs tied when nothing tells them apart', async () => {
    metronHasThree = true;
    writeFiles(drive, {
      'Loose/Copperline 003.cbz': makeCbz({
        pages: 4,
        comicInfo: { Series: 'Copperline', Number: '3' },
      }),
    });
    await api.post('/api/scan', {});
    await made.scans.wait();
    await api.put('/api/settings/metron', { token: 'tok-1234567890abcdef' });
    await lookUp();
    expect(
      db
        .prepare('SELECT identity FROM items WHERE id = ?')
        .pluck()
        .get(itemOf('Copperline 003.cbz')),
    ).toBe('tie');
  });
});
