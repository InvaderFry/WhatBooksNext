import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { addSameMatchSuggestions } from './identify/reconcile.ts';
import { setSuggestedCoverage } from './lib/coverage.ts';
import { makeCbz } from './testing/fixtures.ts';
import type { DB } from './db/database.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Series, order and gaps (M4: PLAN.md §12.5, §13.4), through the API. All names invented. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
  put: (url: string, body: object) => request(made.app).put(url).set('Host', HOST).send(body),
  delete: (url: string) => request(made.app).delete(url).set('Host', HOST).send({}),
};

const volume = (n: number | null, title = `The Ember Roads ${n ?? 'Side Story'}`) =>
  makeEpub({
    title,
    creators: ['Wren Okonkwo-Hale'],
    language: 'en',
    series: 'The Ember Roads',
    ...(n !== null ? { seriesIndex: String(n) } : {}),
    chapters: [3000],
  });

beforeEach(async () => {
  drive = tempDir('wbn-m4-series-');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

async function scan() {
  await api.post('/api/scan', {});
  await made.scans.wait();
}

async function addAndScan(files: Record<string, Buffer>) {
  writeFiles(drive, files);
  expect((await api.post('/api/folders', { path: drive })).status).toBe(200);
  await scan();
}

const itemIdOf = (name: string) =>
  db
    .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?')
    .pluck()
    .get(name) as string;

const seriesIdOf = (name: string) =>
  db.prepare('SELECT series_id FROM items WHERE id = ?').pluck().get(itemIdOf(name)) as string;

const ownedVolumes = () => ({
  'Ember/emberroads1.epub': volume(1),
  'Ember/emberroads2.epub': volume(2),
  'Ember/emberroads4.epub': volume(4),
});

describe('series (§12.5)', () => {
  it('puts the volumes of one series in order, in one series with its own id', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    expect(id).toBeTruthy();
    expect(seriesIdOf('emberroads4.epub')).toBe(id);
    const s = (await api.get(`/api/series/${id}`)).body;
    expect(s.name).toBe('The Ember Roads');
    expect(s.status).toBe('unknown');
    expect(s.entries.map((e: { label: string }) => e.label)).toEqual(['1', '2', '4']);
    expect(s.gaps).toEqual([
      expect.objectContaining({ from: 3, to: 3, state: 'not_owned', unit: 'volume' }),
    ]);
  });

  it('keeps a series’ id through rescans, so corrections to it stay attached', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    expect((await api.put(`/api/series/${id}`, { status: 'finished' })).status).toBe(200);
    writeFiles(drive, { 'Ember/emberroads5.epub': volume(5) });
    await scan();
    expect(seriesIdOf('emberroads5.epub')).toBe(id);
    const s = (await api.get(`/api/series/${id}`)).body;
    expect(s).toMatchObject({ status: 'finished', statusSource: 'owner', ownerStatus: 'finished' });
  });

  it('warns about volume 3 on the volume 1 card before the series is started (scenario 3)', async () => {
    await addAndScan(ownedVolumes());
    const next = (await api.get('/api/next')).body;
    const card = next.cards.find((c: { title: string }) => /Ember Roads/.test(c.title));
    expect(card.title).toBe('The Ember Roads 1');
    expect(card.gaps.map((g: { text: string }) => g.text)).toEqual([
      'Gap ahead: volume 3 isn’t recorded as owned or read.',
    ]);
    // Volume 3 is never listed as owned, and volume 2 and 4 wait their turn.
    expect(next.cards.filter((c: { title: string }) => /Ember Roads/.test(c.title))).toHaveLength(
      1,
    );
  });

  it('offers volume 4 with the warning once volumes 1 and 2 are read (scenario 3)', async () => {
    await addAndScan(ownedVolumes());
    for (const n of [1, 2])
      await api.patch(`/api/items/${itemIdOf(`emberroads${n}.epub`)}`, { progress: 'finished' });
    const card = (await api.get('/api/next')).body.cards.find((c: { title: string }) =>
      /Ember Roads/.test(c.title),
    );
    expect(card.title).toBe('The Ember Roads 4');
    expect(card.scope).toMatch(/^Next in series · vol\. 4 · /);
    expect(card.gaps[0].text).toBe('Gap: volume 3 isn’t recorded as owned or read.');
  });

  it('marks a gap read elsewhere: the gap closes, nothing new is recommended, no finish date is invented', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    const r = await api.post(`/api/series/${id}/read-elsewhere`, { unit: 'volume', from: 3 });
    expect(r.status).toBe(200);
    const [entryId] = r.body.itemIds as string[];
    const s = (await api.get(`/api/series/${id}`)).body;
    expect(s.gaps).toEqual([]);
    expect(s.entries.find((e: { id: string }) => e.id === entryId)).toMatchObject({
      label: '3',
      holding: 'read_elsewhere',
      availabilityLabel: 'Read elsewhere',
      progress: 'finished',
    });
    const entry = (await api.get(`/api/items/${entryId}`)).body;
    expect(entry.user).toMatchObject({ finishedOn: null, finishedPrecision: 'unknown' });
    const titles = (await api.get('/api/next')).body.cards.map((c: { title: string }) => c.title);
    expect(titles).not.toContain('The Ember Roads Vol. 3');
    // Marking it again changes nothing: something is already at number 3.
    const again = await api.post(`/api/series/${id}/read-elsewhere`, { unit: 'volume', from: 3 });
    expect(again.body.itemIds).toEqual([]);
  });

  it('removes a read-elsewhere entry made by mistake, but never a book with files', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    const [entryId] = (
      await api.post(`/api/series/${id}/read-elsewhere`, { unit: 'volume', from: 3 })
    ).body.itemIds as string[];
    expect((await api.delete(`/api/items/${entryId}`)).status).toBe(200);
    expect((await api.get(`/api/series/${id}`)).body.gaps).toHaveLength(1);
    expect((await api.delete(`/api/items/${itemIdOf('emberroads1.epub')}`)).status).toBe(409);
  });

  it('lets the owner number an unnumbered installment, and keeps that through a rescan', async () => {
    await addAndScan({ ...ownedVolumes(), 'Ember/emberroads_extra.epub': volume(null, 'Ashfall') });
    const extra = itemIdOf('emberroads_extra.epub');
    const id = seriesIdOf('emberroads1.epub');
    expect((await api.get(`/api/series/${id}`)).body.unnumbered).toBe(1);
    await api.patch(`/api/items/${extra}`, { seriesPositionOverride: 3 });
    await scan();
    const s = (await api.get(`/api/series/${id}`)).body;
    expect(s.gaps).toEqual([]);
    expect(s.unnumbered).toBe(0);
    expect(s.orderSource).toBe('owner');
  });

  it('lets the owner take a book out of a series, or put it in another', async () => {
    await addAndScan(ownedVolumes());
    const four = itemIdOf('emberroads4.epub');
    await api.patch(`/api/items/${four}`, { seriesOverride: '' });
    expect(db.prepare('SELECT series_id FROM items WHERE id = ?').pluck().get(four)).toBeNull();
    await api.patch(`/api/items/${four}`, { seriesOverride: 'Tales of the Ember Roads' });
    const item = (await api.get(`/api/items/${four}`)).body;
    expect(item.series).toMatchObject({ name: 'Tales of the Ember Roads', position: 4 });
    await api.patch(`/api/items/${four}`, { seriesOverride: null });
    expect(seriesIdOf('emberroads4.epub')).toBe(seriesIdOf('emberroads1.epub'));
  });

  it('restores series and the owner’s corrections from a backup, with the same ids', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    await api.put(`/api/series/${id}`, { status: 'ongoing' });
    const backup = (await api.get('/api/backup')).body;
    await api.put(`/api/series/${id}`, { status: null });
    expect((await api.post('/api/restore', { backup, confirm: true })).status).toBe(200);
    expect((await api.get(`/api/series/${id}`)).body).toMatchObject({
      status: 'ongoing',
      statusSource: 'owner',
    });
  });

  it('rebuilds series when restoring a backup made before series had their own rows', async () => {
    await addAndScan(ownedVolumes());
    const backup = (await api.get('/api/backup')).body;
    backup.schemaVersion = 4;
    delete backup.tables.series_user;
    backup.tables.series = [];
    for (const r of backup.tables.items) {
      delete r.series_unit;
      r.series_id = null;
      r.series_position = null;
    }
    for (const r of backup.tables.user_item) {
      delete r.series_override;
      delete r.series_position_override;
    }
    expect((await api.post('/api/restore', { backup, confirm: true })).status).toBe(200);
    const id = seriesIdOf('emberroads1.epub');
    expect(id).toBeTruthy();
    expect((await api.get(`/api/series/${id}`)).body.gaps).toHaveLength(1);
  });

  it('refuses a bad read-elsewhere request plainly', async () => {
    await addAndScan(ownedVolumes());
    const id = seriesIdOf('emberroads1.epub');
    expect(
      (await api.post(`/api/series/${id}/read-elsewhere`, { unit: 'volume', from: 1, to: 900 }))
        .status,
    ).toBe(400);
    expect(
      (await api.post('/api/series/nope/read-elsewhere', { unit: 'volume', from: 3 })).status,
    ).toBe(404);
  });

  it('asks whether two entries matched to the same book are one book, and shows it once meanwhile', async () => {
    await addAndScan({
      'A/emberroads1.epub': volume(1),
      'B/Ember Roads Book One.epub': volume(1, 'The Ember Roads: Book One'),
    });
    const a = itemIdOf('emberroads1.epub');
    const b = itemIdOf('Ember Roads Book One.epub');
    expect(a).not.toBe(b);
    db.prepare(
      "UPDATE items SET identity = 'provisional', match_source = 'hardcover', match_source_id = '77' WHERE id IN (?, ?)",
    ).run(a, b);
    expect(addSameMatchSuggestions(db)).toBe(1);
    expect(addSameMatchSuggestions(db)).toBe(0); // asked once
    const review = (await api.get('/api/review')).body;
    const row = JSON.stringify(review);
    expect(row).toContain('Both were matched to the same book on Hardcover');
    const cards = (await api.get('/api/next')).body.cards.filter((c: { id: string }) =>
      [a, b].includes(c.id),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].limitations).toContain(
      'also in your library under another name — see Needs review',
    );
  });
});

describe('collected editions and their issues (§12.5)', () => {
  const comic = (n: number) =>
    makeCbz({ pages: 4, comicInfo: { Series: 'Copperline', Number: String(n), Year: '2019' } });
  async function setUp() {
    await addAndScan({
      'Copperline/Copperline 002 (2019).cbz': comic(2),
      'Copperline/Copperline 004 (2019).cbz': comic(4),
      'Trades/copperline_vol1.cbz': makeCbz({ pages: 8 }),
    });
    const tpb = itemIdOf('copperline_vol1.cbz');
    const series = seriesIdOf('Copperline 002 (2019).cbz');
    expect(seriesIdOf('copperline_vol1.cbz')).toBe(series);
    return { tpb, series };
  }
  const gapsOf = async (series: string) =>
    (await api.get(`/api/series/${series}`)).body.gaps as { state: string; text: string }[];

  it('shows a suggested collection as “may be covered” until confirmed (scenario 4)', async () => {
    const { tpb, series } = await setUp();
    expect((await gapsOf(series)).map((g) => g.state)).toEqual(['not_owned']);
    setSuggestedCoverage(db, tpb, 'metron', [{ seriesId: series, first: 1, last: 6 }]);
    const [gap] = await gapsOf(series);
    expect(gap).toMatchObject({
      state: 'maybe_covered',
      text: expect.stringContaining('may be in'),
    });
    // The series offers the trade first; once it's read, issue 2 comes next, with the gap ahead.
    await api.patch(`/api/items/${tpb}`, { progress: 'finished' });
    const card = (await api.get('/api/next')).body.cards.find(
      (c: { title: string }) => c.title === 'Copperline #2',
    );
    expect(card.gaps[0]).toMatchObject({ state: 'maybe_covered' });
    const covId = (await api.get(`/api/items/${tpb}/coverage`)).body.rows[0].id as string;
    expect((await api.post(`/api/coverage/${covId}`, { action: 'confirm' })).status).toBe(200);
    expect(await gapsOf(series)).toEqual([]);
  });

  it('never suggests again what the owner rejected', async () => {
    const { tpb, series } = await setUp();
    setSuggestedCoverage(db, tpb, 'metron', [{ seriesId: series, first: 1, last: 6 }]);
    const covId = (await api.get(`/api/items/${tpb}/coverage`)).body.rows[0].id as string;
    await api.post(`/api/coverage/${covId}`, { action: 'reject' });
    setSuggestedCoverage(db, tpb, 'metron', [{ seriesId: series, first: 1, last: 6 }]);
    expect((await api.get(`/api/items/${tpb}/coverage`)).body.rows).toEqual([]);
    expect((await gapsOf(series)).map((g) => g.state)).toEqual(['not_owned']);
  });

  it('counts finishing a confirmed collection as reading its issues, once (scenario 20)', async () => {
    const { tpb, series } = await setUp();
    expect(
      (await api.post(`/api/items/${tpb}/coverage`, { seriesId: series, first: 1, last: 6 }))
        .status,
    ).toBe(200);
    await api.patch(`/api/items/${tpb}`, { progress: 'finished' });
    const titles = (await api.get('/api/next')).body.cards.map((c: { title: string }) => c.title);
    expect(titles.filter((t: string) => /Copperline/i.test(t))).toEqual([]);
    // Nothing was written to the issues: one reading, where the owner marked it.
    expect(
      db.prepare("SELECT COUNT(*) FROM user_item WHERE progress = 'finished'").pluck().get(),
    ).toBe(1);
    const s = (await api.get(`/api/series/${series}`)).body;
    expect(
      s.entries
        .filter((e: { via: string | null }) => e.via === 'collection')
        .map((e: { label: string }) => e.label),
    ).toEqual(['2', '4']);
  });

  it('stops recommending a collection once every issue in it is read', async () => {
    const { tpb, series } = await setUp();
    await api.post(`/api/items/${tpb}/coverage`, { seriesId: series, first: 2, last: 4 });
    await api.post(`/api/series/${series}/read-elsewhere`, { unit: 'issue', from: 3 });
    for (const n of [2, 4])
      await api.patch(`/api/items/${itemIdOf(`Copperline 00${n} (2019).cbz`)}`, {
        progress: 'finished',
      });
    const ids = (await api.get('/api/next')).body.cards.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(tpb);
  });
});
