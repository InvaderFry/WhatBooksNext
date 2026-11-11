import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import type { Fetcher } from './sources/types.ts';
import { fakePlatformWithDrives, memoryDb } from './testing/helpers.ts';
import { storeFile } from './testing/storeFile.ts';

/**
 * New store books are unverified until a lookup finds them, so an import starts lookups as a
 * scan does, under the same "look up new books automatically" setting. Recorded answers only.
 */

const PORT = 4831;
const HOST = `localhost:${PORT}`;
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'sources');

let db: DB;
let made: ReturnType<typeof createApp>;

const fetcher: Fetcher = async (url) =>
  new URL(url).hostname === 'openlibrary.org'
    ? new Response(fs.readFileSync(path.join(FIXTURES, 'ol-search-none.json'), 'utf8'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    : new Response('{}', { status: 404 });

async function start() {
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    fetcher,
  });
}
const post = (url: string, body: object) =>
  request(made.app).post(url).set('Host', HOST).send(body);

afterEach(async () => {
  await made.lookups.wait();
  await made.close();
});

const FILE = storeFile([
  { id: 'INVENTED0201', title: 'The Orchard Ledger', author: 'Pim Arkwright' },
]);

describe('lookups after a store import', () => {
  it('looks up the new books straight away', async () => {
    await start();
    expect((await post('/api/import/store-purchases', { text: FILE })).body.added).toBe(1);
    expect(made.lookups.status()).not.toBeNull();
    await made.lookups.wait();
    const item = db.prepare('SELECT id FROM items').pluck().get();
    expect(
      db
        .prepare("SELECT COUNT(*) FROM lookup_state WHERE item_id = ? AND source = 'openlibrary'")
        .pluck()
        .get(item),
    ).toBe(1);
  });

  it('waits when the owner turned automatic lookups off', async () => {
    await start();
    await request(made.app)
      .patch('/api/settings/lookups')
      .set('Host', HOST)
      .send({ afterScan: false });
    await post('/api/import/store-purchases', { text: FILE });
    expect(made.lookups.isRunning()).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM lookup_state').pluck().get()).toBe(0);
  });
});
