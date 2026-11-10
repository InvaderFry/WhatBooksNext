import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { BACKUP_TABLES } from './lib/backup.ts';
import { buildDemoLibrary } from './lib/demo.ts';
import { FULL_SNAPSHOT_DB } from './lib/fullSnapshot.ts';
import { createStoreItem } from './lib/store.ts';
import { applyUserPatch } from './lib/progress.ts';
import type { Platform } from './platform/types.ts';
import { fakePlatformWithDrives, memoryDb, tempDir } from './testing/helpers.ts';

/** Milestone 6: restore across every table, full snapshots, the CSV export, Stats, Diagnostics. */

const HOST = 'localhost:4818';
let made: ReturnType<typeof createApp> | null = null;
const dirs: string[] = [];

const api = {
  get: (url: string) => request(made!.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made!.app).post(url).set('Host', HOST).send(body),
  put: (url: string, body: object) => request(made!.app).put(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made!.app).patch(url).set('Host', HOST).send(body),
};

async function start(db: DB, platform: Platform, dataDir: string | null) {
  if (made) await made.close();
  made = createApp({
    db,
    platform,
    port: 4818,
    dataDir,
    snapshotDir: dataDir ? path.join(dataDir, 'snapshots') : null,
    autoLookups: false,
    fetcher: async () => new Response('{}', { status: 404 }),
  });
}

/** The demo library: every kind of record the app makes (§17). */
async function demo() {
  const dataDir = tempDir('wbn-m6-');
  dirs.push(dataDir);
  const db = await memoryDb();
  const platform = await buildDemoLibrary(
    db,
    path.join(dataDir, 'library'),
    path.join(dataDir, 'covers'),
  );
  await start(db, platform, dataDir);
  return { db, dataDir, platform };
}

afterEach(async () => {
  if (made) await made.close();
  made = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const one = (db: DB, sql: string) => db.prepare(sql).pluck().get() as string;

/** Every table's rows, in a stable order, for comparing two databases. */
function dump(db: DB): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of BACKUP_TABLES)
    out[t] = (db.prepare(`SELECT * FROM ${t}`).all() as object[])
      .map((r) => JSON.stringify(r))
      .sort();
  return out;
}

describe('restore regression across every table (§16)', () => {
  it('brings back every row of every backed-up table exactly, and the same Stats', async () => {
    const { db } = await demo();
    // The demo doesn't make these records; make one of each through the app, as the owner would.
    expect((await api.put('/api/tune', { strength: 'low' })).status).toBe(200);
    expect(
      (
        await api.put(`/api/series/${one(db, 'SELECT id FROM series LIMIT 1')}`, {
          status: 'finished',
        })
      ).status,
    ).toBe(200);
    const pdf = one(db, "SELECT id FROM files WHERE format = 'pdf' LIMIT 1");
    expect((await api.patch(`/api/files/${pdf}`, { pdfTypeOverride: 'text' })).status).toBe(200);
    const m = db.prepare('SELECT item_id, source, source_id FROM item_matches LIMIT 1').get() as {
      item_id: string;
      source: string;
      source_id: string;
    };
    expect(
      (
        await api.post(`/api/items/${m.item_id}/match`, {
          action: 'reject',
          source: m.source,
          sourceId: m.source_id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await api.post('/api/review-state', { key: 'invented-key', state: 'dismissed' })).status,
    ).toBe(200);
    expect(
      (
        await api.post('/api/feedback', {
          itemId: one(db, 'SELECT item_id FROM user_item LIMIT 1'),
          reason: 'not_in_mood',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.post('/api/import/csv', {
          text: 'title,author,store\nAn Invented Import,Ola Pennant,kobo\n',
        })
      ).status,
    ).toBe(200);

    // Guard: a new table must get a row here too, or this test would prove nothing about it.
    const empty = BACKUP_TABLES.filter(
      (t) => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() === 0,
    );
    expect(empty).toEqual([]);

    const before = dump(db);
    const statsBefore = (await api.get('/api/stats')).body;
    const backup = (await api.get('/api/backup')).body;

    // An empty app with no drive connected.
    const fresh = await memoryDb();
    await start(fresh, fakePlatformWithDrives({}), null);
    expect((await api.post('/api/restore', { backup, confirm: true })).status).toBe(200);

    const after = dump(fresh);
    for (const t of BACKUP_TABLES)
      expect({ table: t, rows: after[t] }).toEqual({ table: t, rows: before[t] });
    const statsAfter = (await api.get('/api/stats')).body;
    // Folders aren't connected now, which Stats doesn't depend on.
    expect(statsAfter).toEqual(statsBefore);
  }, 30_000);
});

describe('full local snapshot (§16)', () => {
  it('copies the database and the covers, without API keys, and keeps the last three', async () => {
    const { db, dataDir } = await demo();
    db.prepare(
      "INSERT INTO secrets (name, value, updated_at) VALUES ('hardcover', 'invented-token', '2026-01-01')",
    ).run();
    const covers = fs.readdirSync(path.join(dataDir, 'covers'), { recursive: true }).length;
    expect(covers).toBeGreaterThan(0);

    const r = await api.post('/api/snapshots/full');
    expect(r.status).toBe(200);
    const dir = r.body.snapshot.path as string;
    expect(path.dirname(dir)).toBe(path.join(dataDir, 'full-snapshots'));
    expect(fs.readdirSync(path.join(dir, 'covers'), { recursive: true }).length).toBe(covers);
    expect(fs.readFileSync(path.join(dir, 'README.txt'), 'utf8')).toMatch(
      /API keys are NOT included/,
    );

    const copy = new Database(path.join(dir, FULL_SNAPSHOT_DB), { readonly: true });
    try {
      expect(copy.prepare('SELECT COUNT(*) FROM secrets').pluck().get()).toBe(0);
      expect(copy.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(
        db.prepare('SELECT COUNT(*) FROM items').pluck().get(),
      );
    } finally {
      copy.close();
    }
    const raw = fs.readFileSync(path.join(dir, FULL_SNAPSHOT_DB));
    expect(raw.includes(Buffer.from('invented-token'))).toBe(false);
    // The live database keeps its key.
    expect(db.prepare('SELECT COUNT(*) FROM secrets').pluck().get()).toBe(1);

    for (let i = 0; i < 3; i++) {
      await new Promise((ok) => setTimeout(ok, 5)); // distinct timestamps
      expect((await api.post('/api/snapshots/full')).status).toBe(200);
    }
    const list = (await api.get('/api/snapshots/full')).body.snapshots;
    expect(list).toHaveLength(3);
    expect(list.map((s: { path: string }) => s.path)).not.toContain(dir);
    expect((await api.get('/api/diagnostics')).body.snapshots.full).toBe(3);
  }, 30_000);

  it('takes snapshots asked for at the same moment one after another, each in its own folder', async () => {
    await demo();
    const results = await Promise.all([1, 2, 3].map(() => api.post('/api/snapshots/full')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const paths = results.map((r) => r.body.snapshot.path as string);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) expect(fs.existsSync(path.join(p, FULL_SNAPSHOT_DB))).toBe(true);
    const listed = (await api.get('/api/snapshots/full')).body.snapshots.map(
      (x: { path: string }) => x.path,
    );
    expect(listed.sort()).toEqual([...paths].sort());
  }, 30_000);

  it('says so when there is no data folder to save into', async () => {
    await start(await memoryDb(), fakePlatformWithDrives({}), null);
    expect((await api.get('/api/snapshots/full')).body).toEqual({
      available: false,
      snapshots: [],
    });
    expect((await api.post('/api/snapshots/full')).status).toBe(400);
  });
});

describe('CSV export (§16)', () => {
  it('writes one row per book, with unknown dates left empty and formulas kept as text', async () => {
    const db = await memoryDb();
    await start(db, fakePlatformWithDrives({}), null);
    const a = createStoreItem(db, {
      title: '=HYPERLINK("http://example.invalid")',
      author: 'Ola Pennant',
      kind: 'fiction',
      store: 'kindle',
    });
    applyUserPatch(db, a, { progress: 'finished', finishedPrecision: 'unknown', rating: 8 });
    const b = createStoreItem(db, {
      title: 'A Book, With "Quotes"',
      author: 'Ivo Brask',
      kind: 'nonfiction',
      store: 'kobo',
    });
    applyUserPatch(db, b, {
      progress: 'finished',
      finishedOn: '2025-04-02',
      finishedPrecision: 'exact',
      note: 'Line one\nline two',
    });

    const r = await api.get('/api/export/csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(
      /attachment; filename="whatbooksnext-library-/,
    );
    const text = r.text.replace(/^\uFEFF/, '');
    const lines = text.split('\r\n');
    expect(lines[0]).toMatch(/Not a backup/);
    const header = lines[1]!.split(',');
    expect(header.slice(0, 3)).toEqual(['title', 'author', 'kind']);
    expect(text).toContain('"A Book, With ""Quotes"""');
    expect(text).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(text).toContain('"Line one\nline two"');
    const finishedCol = header.indexOf('finished_on');
    const kindle = lines.find((l) => l.includes('HYPERLINK'))!;
    // The quoted title holds a comma-free body, so a plain split finds the columns.
    expect(kindle.split(',')[finishedCol]).toBe('');
    expect(text).toContain(',2025-04-02,');
  });
});

describe('Stats route (§15)', () => {
  it('serves facts, estimates, taste and the match summary for the demo', async () => {
    await demo();
    const s = (await api.get('/api/stats')).body;
    expect(s.library.owned).toBeGreaterThan(0);
    expect(s.library.readElsewhere).toBe(10);
    expect(s.coverage.length).toBeGreaterThan(0);
    expect(s.backlog.total.items).toBeGreaterThan(0);
    expect(s.finishes.undated).toBeGreaterThan(0);
    expect(s.taste.active).toBe(true);
    expect(s.matches.byBand).toBeDefined();
    expect(s.readRate.byFolder.length).toBe(3);
  }, 30_000);
});

describe('Diagnostics (§15)', () => {
  async function oneBook() {
    const drive = tempDir('wbn-m6-drive-');
    dirs.push(drive);
    fs.writeFileSync(path.join(drive, 'invented.epub'), 'x'.repeat(100));
    const platform = fakePlatformWithDrives({ drive });
    await start(await memoryDb(), platform, null);
    expect((await api.post('/api/folders', { path: drive })).status).toBe(200);
    await api.post('/api/scan', {});
    await made!.scans.wait();
    const item = (await api.get('/api/items')).body.items[0];
    const file = (await api.get(`/api/items/${item.id}`)).body.files[0];
    return { platform, fileId: file.id as string };
  }
  const lastLaunch = async () => (await api.get('/api/diagnostics')).body.lastLaunch;

  it('reports whether the last Open worked', async () => {
    const { fileId } = await oneBook();
    expect(await lastLaunch()).toBeNull();
    expect((await api.post(`/api/files/${fileId}/open`)).status).toBe(200);
    expect(await lastLaunch()).toMatchObject({ action: 'open', ok: true, error: null });
  });

  it('reports a failed Open when the launcher fails, never success', async () => {
    const { platform, fileId } = await oneBook();
    platform.launchError = 'spawn explorer.exe ENOENT';
    const r = await api.post(`/api/files/${fileId}/open`);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/couldn't be opened.*ENOENT/);
    expect(await lastLaunch()).toMatchObject({ action: 'open', ok: false });
  });

  it('replaces an earlier success when the next try fails its file checks', async () => {
    const { platform, fileId } = await oneBook();
    expect((await api.post(`/api/files/${fileId}/open`)).status).toBe(200);
    platform.volumes[0]!.root = null; // drive unplugged
    expect((await api.post(`/api/files/${fileId}/open`)).status).toBe(409);
    expect(await lastLaunch()).toMatchObject({
      action: 'open',
      ok: false,
      error: 'The external drive is not connected.',
    });
    expect((await api.post(`/api/files/${fileId}/show`)).status).toBe(409);
    expect(await lastLaunch()).toMatchObject({ action: 'show', ok: false });
  });
});
