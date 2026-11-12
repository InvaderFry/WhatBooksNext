import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import type { DB } from '../db/database.ts';
import { parseFilename } from '../identify/filename.ts';
import { ATTR_RECALL_ON_DATA_ACCESS } from '../platform/types.ts';
import type { FakePlatform } from '../platform/fake.ts';
import type { TaskRunner } from '../scan/pool.ts';
import { makeCbz, makeImage } from '../testing/fixtures.ts';
import { memoryDb, fakePlatformWithDrives, tempDir } from '../testing/helpers.ts';
import { createStoreItem } from './store.ts';

let db: DB;
let dir: string;
let platform: FakePlatform;
let made: ReturnType<typeof createApp>;
let calls: number;
let itemId: string;
const host = 'localhost:4818';
const get = (url: string) => request(made.app).get(url).set('Host', host);
const post = (url: string) => request(made.app).post(url).set('Host', host).send({});
beforeEach(async () => {
  db = await memoryDb();
  dir = tempDir('wbn-preview-api-');
  platform = fakePlatformWithDrives({ drive: dir });
  calls = 0;
  const runner: TaskRunner = {
    size: 1,
    abort() {},
    async close() {},
    async run(task) {
      if (task.kind !== 'previews') throw new Error('Unexpected read');
      calls++;
      return {
        kind: 'previews',
        pages: [makeImage(100, 150), makeImage(100, 150, 'jpeg', '#0000ff')],
      };
    },
  };
  made = createApp({
    db,
    platform,
    port: 4818,
    dataDir: dir,
    snapshotDir: null,
    runner,
    autoLookups: false,
  });
  itemId = createStoreItem(db, { title: 'Example #1', kind: 'comic', store: 'globalcomix' });
  db.prepare(
    `INSERT INTO folders (id,display_path,volume_id,relative_path,storage_kind,created_at,updated_at)
    VALUES ('folder',?,'vol-drive','','external','2026-01-01','2026-01-01')`,
  ).run(dir);
  fs.writeFileSync(path.join(dir, 'example.cbz'), makeCbz());
  const stat = fs.statSync(path.join(dir, 'example.cbz'));
  db.prepare(
    `INSERT INTO files (id,folder_id,rel_path,rel_dir,name,ext,format,size,modified_ms,availability,compare_key,first_seen_at,parsed)
    VALUES ('file','folder','example.cbz','','example.cbz','cbz','cbz',?,?,'present','example','2026-01-01',?)`,
  ).run(stat.size, Math.round(stat.mtimeMs), JSON.stringify(parseFilename('example.cbz')));
  db.prepare('INSERT INTO item_files (item_id,file_id,is_primary) VALUES (?, ?, 1)').run(
    itemId,
    'file',
  );
});
afterEach(async () => {
  await made.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('page preview API', () => {
  it('GET only inspects cache; POST generates once and cached pages work with the drive disconnected', async () => {
    const status = await get(`/api/items/${itemId}/page-previews`);
    expect(status.status).toBe(200);
    expect(status.body.files[0].pages).toEqual([]);
    expect(calls).toBe(0);
    const generated = await post('/api/files/file/page-previews');
    expect(generated.status).toBe(200);
    expect(generated.body.pages).toHaveLength(2);
    expect(calls).toBe(1);
    platform.volumes[0]!.root = null;
    expect((await post('/api/files/file/page-previews')).status).toBe(200);
    const image = await get(generated.body.pages[1].url);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toContain('image/jpeg');
    expect(calls).toBe(1);
  });
  it('refuses a cloud placeholder immediately before reading, even if the scan recorded it as present', async () => {
    platform.attributes.set(path.join(dir, 'example.cbz'), ATTR_RECALL_ON_DATA_ACCESS);
    const result = await post('/api/files/file/page-previews');
    expect(result.status).toBe(409);
    expect(result.body.error).toContain('online-only');
    expect(calls).toBe(0);
  });
  it('invalidates previews when scanned file facts change', async () => {
    const generated = await post('/api/files/file/page-previews');
    db.prepare("UPDATE files SET modified_ms = modified_ms + 1000 WHERE id = 'file'").run();
    expect((await get(generated.body.pages[0].url)).status).toBe(404);
    expect((await post('/api/files/file/page-previews')).status).toBe(409);
    expect(calls).toBe(1);
    expect((await get(`/api/items/${itemId}/page-previews`)).body.files[0].pages).toEqual([]);
  });
  it('offers an honest empty state for imports without files, and rejects unknown files/pages', async () => {
    const imported = createStoreItem(db, { title: 'Imported book', store: 'kindle' });
    expect((await get(`/api/items/${imported}/page-previews`)).body.files).toEqual([]);
    expect((await post('/api/files/not-a-file/page-previews')).status).toBe(404);
    await post('/api/files/file/page-previews');
    expect((await get('/api/files/file/page-previews/3')).status).toBe(404);
    expect((await get('/api/files/file/page-previews/0')).status).toBe(404);
  });
  it('blocks generation from foreign websites', async () => {
    const result = await request(made.app)
      .post('/api/files/file/page-previews')
      .set('Host', host)
      .set('Origin', 'https://attacker.example')
      .send({});
    expect(result.status).toBe(403);
    expect(calls).toBe(0);
  });
});
