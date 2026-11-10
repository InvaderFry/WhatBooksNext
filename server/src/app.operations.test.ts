import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Merge, split and undo (M4: PLAN.md §11.4, scenarios 13 and 19). All names invented. */

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
};

const book = (title: string, seed: number) =>
  makeEpub({ title, creators: ['Ilse Marrow'], language: 'en', chapters: [800], seed });

beforeEach(async () => {
  drive = tempDir('wbn-m4-ops-');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
  });
  // Pairs of entries for one book under different names, in different folders.
  writeFiles(drive, {
    'A/harrowfield.epub': book('Harrowfield', 1),
    'B/Harrowfield (Anniversary).epub': book('Harrowfield', 2),
    'A/the_salt_ledger.epub': book('The Salt Ledger', 3),
    'B/Salt Ledger, The.epub': book('The Salt Ledger', 4),
    'A/kestrelmoon.epub': book('Kestrel Moon', 5),
    'B/Kestrel Moon - Ilse Marrow.epub': book('Kestrel Moon', 6),
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
const fileId = (name: string) =>
  db.prepare('SELECT id FROM files WHERE name = ?').pluck().get(name) as string;

/** Every row of these items, for comparing "exactly as before". */
function stateOf(ids: string[]) {
  const q = (sql: string) => db.prepare(sql).all(...ids);
  const m = ids.map(() => '?').join(',');
  return {
    items: q(`SELECT * FROM items WHERE id IN (${m}) ORDER BY id`),
    user: q(`SELECT * FROM user_item WHERE item_id IN (${m}) ORDER BY item_id`),
    files: q(`SELECT * FROM item_files WHERE item_id IN (${m}) ORDER BY file_id`),
    aliases: db
      .prepare(
        `SELECT old_id, new_id FROM id_aliases WHERE old_id IN (${m}) OR new_id IN (${m}) ORDER BY old_id`,
      )
      .all(...ids, ...ids),
  };
}

describe('merge (§11.4)', () => {
  it('shows only what conflicts, and refuses to guess', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.patch(`/api/items/${a}`, { progress: 'halfway', rating: 7, note: 'Slow start.' });
    await api.patch(`/api/items/${b}`, {
      progress: 'finished',
      finishedPrecision: 'unknown',
      rating: 7,
      triage: 'want',
    });
    const p = (await api.post('/api/merge/preview', { keepId: a, otherId: b })).body;
    expect(p.conflicts.map((c: { field: string }) => c.field)).toEqual(['progress']);
    expect(p.conflicts[0]).toMatchObject({ keep: 'Halfway', other: 'Finished, date unknown' });
    expect(p.carried).toEqual(['Triage: want']);
    expect((await api.post('/api/merge', { keepId: a, otherId: b, choices: {} })).status).toBe(400);
  });

  it('merges files and history with the owner’s choices; the old id still leads to the book', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.patch(`/api/items/${a}`, { progress: 'halfway', note: 'Slow start.' });
    await api.patch(`/api/items/${b}`, {
      progress: 'finished',
      finishedOn: '2025-03',
      note: 'Loved the ending.',
    });
    const r = await api.post('/api/merge', {
      keepId: a,
      otherId: b,
      choices: { progress: 'other', note: 'both' },
    });
    expect(r.status).toBe(200);
    const item = (await api.get(`/api/items/${b}`)).body;
    expect(item.id).toBe(a);
    expect(item.redirectedFrom).toBe(b);
    expect(item.files).toHaveLength(2);
    expect(item.user).toMatchObject({
      progress: 'finished',
      finishedOn: '2025-03',
      note: 'Slow start.\n\nLoved the ending.',
    });
  });

  it('never credits a reading twice when both copies were finished', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.patch(`/api/items/${a}`, { progress: 'finished', finishedOn: '2024' });
    await api.patch(`/api/items/${b}`, { progress: 'finished', finishedOn: '2024' });
    await api.post('/api/merge', { keepId: a, otherId: b, choices: {} });
    expect(
      db.prepare("SELECT COUNT(*) FROM user_item WHERE progress = 'finished'").pluck().get(),
    ).toBe(1);
  });
});

describe('undo (§11.4)', () => {
  it('puts a merge back exactly, even after later merges of other books (scenario 13)', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.patch(`/api/items/${a}`, { progress: 'halfway', rating: 6 });
    await api.patch(`/api/items/${b}`, {
      progress: 'finished',
      finishedPrecision: 'unknown',
      rating: 9,
    });
    const before = stateOf([a, b]);
    const first = (
      await api.post('/api/merge', {
        keepId: a,
        otherId: b,
        choices: { progress: 'other', rating: 'other' },
      })
    ).body.operationId;
    for (const [x, y] of [
      ['the_salt_ledger.epub', 'Salt Ledger, The.epub'],
      ['kestrelmoon.epub', 'Kestrel Moon - Ilse Marrow.epub'],
    ])
      expect(
        (await api.post('/api/merge', { keepId: itemOf(x!), otherId: itemOf(y!), choices: {} }))
          .status,
      ).toBe(200);
    const salt = itemOf('the_salt_ledger.epub');

    const ops = (await api.get('/api/operations')).body;
    expect(ops).toHaveLength(3);
    expect(ops.find((o: { id: string }) => o.id === first)).toMatchObject({ canUndo: true });
    expect((await api.post(`/api/operations/${first}/undo`)).status).toBe(200);
    expect(stateOf([a, b])).toEqual(before);
    // The later merges are untouched.
    expect(itemOf('Salt Ledger, The.epub')).toBe(salt);
    expect(
      (await api.get('/api/operations')).body.find((o: { id: string }) => o.id === first),
    ).toMatchObject({
      canUndo: false,
      undoneAt: expect.any(String),
    });
  });

  it('offers a split instead of undo once the merged book has new progress (scenario 19)', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.patch(`/api/items/${b}`, { rating: 8 });
    const op = (await api.post('/api/merge', { keepId: a, otherId: b, choices: {} })).body
      .operationId;
    await api.patch(`/api/items/${a}`, { progress: 'nearly_done' });
    const view = (await api.get('/api/operations')).body.find((o: { id: string }) => o.id === op);
    expect(view.canUndo).toBe(false);
    expect(view.blockedBecause).toMatch(/changed these books since/);
    expect(view.instead).toEqual({
      kind: 'split',
      itemId: a,
      fileIds: [fileId('Harrowfield (Anniversary).epub')],
    });
    expect((await api.post(`/api/operations/${op}/undo`)).status).toBe(409);
    // The split keeps the new progress where the owner chooses: here, with the original book.
    const preview = (
      await api.post('/api/split/preview', { itemId: a, fileIds: view.instead.fileIds })
    ).body;
    expect(preview.ownerData).toEqual(
      expect.arrayContaining(['Progress: Nearly done', 'Your rating: 8/10']),
    );
    const s = await api.post('/api/split', {
      itemId: a,
      fileIds: view.instead.fileIds,
      ownerData: 'stay',
    });
    expect(s.status).toBe(200);
    expect((await api.get(`/api/items/${a}`)).body.user.progress).toBe('nearly_done');
    expect((await api.get(`/api/items/${s.body.newItemId}`)).body.user.progress).toBe(
      'not_started',
    );
  });

  it('won’t undo a merge a later merge built on', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    const c = itemOf('kestrelmoon.epub');
    const op = (await api.post('/api/merge', { keepId: a, otherId: b, choices: {} })).body
      .operationId;
    await api.post('/api/merge', { keepId: a, otherId: c, choices: {} });
    const view = (await api.get('/api/operations')).body.find((o: { id: string }) => o.id === op);
    expect(view).toMatchObject({
      canUndo: false,
      blockedBecause: 'A later merge or split changed these books.',
    });
  });

  it('undoes a split, and moves history to the new book when asked', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.post('/api/merge', { keepId: a, otherId: b, choices: {} });
    await api.patch(`/api/items/${a}`, { progress: 'halfway' });
    const before = stateOf([a]);
    const r = (
      await api.post('/api/split', {
        itemId: a,
        fileIds: [fileId('harrowfield.epub')],
        ownerData: 'move',
      })
    ).body;
    expect((await api.get(`/api/items/${r.newItemId}`)).body.user.progress).toBe('halfway');
    expect((await api.get(`/api/items/${a}`)).body.user.progress).toBe('not_started');
    expect((await api.post(`/api/operations/${r.operationId}/undo`)).status).toBe(200);
    expect(stateOf([a])).toEqual(before);
    expect(db.prepare('SELECT 1 FROM items WHERE id = ?').get(r.newItemId)).toBeUndefined();
  });

  it('refuses to split off every file', async () => {
    const a = itemOf('harrowfield.epub');
    expect(
      (await api.post('/api/split/preview', { itemId: a, fileIds: [fileId('harrowfield.epub')] }))
        .status,
    ).toBe(400);
  });

  it('keeps the last 20 merges and splits', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    await api.post('/api/merge', { keepId: a, otherId: b, choices: {} });
    for (let i = 0; i < 11; i++) {
      const r = (
        await api.post('/api/split', {
          itemId: a,
          fileIds: [fileId('Harrowfield (Anniversary).epub')],
          ownerData: 'stay',
        })
      ).body;
      await api.post('/api/merge', { keepId: a, otherId: r.newItemId, choices: {} });
    }
    expect((await api.get('/api/operations')).body).toHaveLength(20);
  });

  it('clears the undo list on restore', async () => {
    const backup = (await api.get('/api/backup')).body;
    await api.post('/api/merge', {
      keepId: itemOf('harrowfield.epub'),
      otherId: itemOf('Harrowfield (Anniversary).epub'),
      choices: {},
    });
    expect((await api.post('/api/restore', { backup, confirm: true })).status).toBe(200);
    expect((await api.get('/api/operations')).body).toEqual([]);
  });
});
