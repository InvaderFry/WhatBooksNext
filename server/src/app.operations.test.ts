import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { applyIdentity, usedMatches } from './identify/lookups.ts';
import { ensureUserRow, shortlistAdd, shortlistMove } from './lib/progress.ts';
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

function confirmMatch(itemId: string, sourceId: string) {
  const record = {
    source: 'openlibrary',
    sourceId,
    title: `Edition ${sourceId}`,
    authors: ['Ilse Marrow'],
    isbns: [],
    subjects: [],
  };
  db.prepare(
    `INSERT INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
    VALUES (?, 'openlibrary', ?, 1, 1, ?, ?, ?)`,
  ).run(
    itemId,
    sourceId,
    JSON.stringify({ title: 1, author: 'agrees', isbn: 'none', notes: [] }),
    JSON.stringify(record),
    new Date().toISOString(),
  );
  ensureUserRow(db, itemId);
  db.prepare('UPDATE user_item SET match_override = ? WHERE item_id = ?').run(
    `openlibrary:${sourceId}`,
    itemId,
  );
  applyIdentity(db, itemId);
}

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
  it.each([false, true])(
    'keeps a manual source choice through merge and undo (existing source: %s)',
    async (existing) => {
      const keepId = itemOf('harrowfield.epub');
      const otherId = itemOf('Harrowfield (Anniversary).epub');
      const insert =
        db.prepare(`INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome, manually_selected)
      VALUES (?, 'anilist', 1, '{}', '2026-01-01', 'none', ?)`);
      if (existing) insert.run(keepId, 0);
      insert.run(otherId, 1);
      const merged = await api.post('/api/merge', { keepId, otherId, choices: {} });
      expect(merged.status).toBe(200);
      const selected = (id: string) =>
        db
          .prepare(
            "SELECT manually_selected FROM lookup_state WHERE item_id = ? AND source = 'anilist'",
          )
          .pluck()
          .get(id);
      expect(selected(keepId)).toBe(1);
      expect((await api.post(`/api/operations/${merged.body.operationId}/undo`)).status).toBe(200);
      expect(selected(otherId)).toBe(1);
      expect(selected(keepId)).toBe(existing ? 0 : undefined);
    },
  );

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

  it('keeps the covers the owner turned down for either book when merging', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    const wrong = db.prepare(
      "INSERT INTO user_item (item_id, cover_rejected, updated_at) VALUES (?, ?, '2026-11-13')",
    );
    wrong.run(a, JSON.stringify(['hardcover:601']));
    wrong.run(b, JSON.stringify(['metron:81', 'hardcover:601']));
    expect((await api.post('/api/merge', { keepId: a, otherId: b, choices: {} })).status).toBe(200);
    const kept = db
      .prepare('SELECT cover_rejected FROM user_item WHERE item_id = ?')
      .pluck()
      .get(a);
    expect(JSON.parse(kept as string)).toEqual(['hardcover:601', 'metron:81']);
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

  it('preserves both import identities through merge and undo so reimporting cannot duplicate history', async () => {
    const text = 'title,author,store,progress\nAnother Library Label,Ada Fen,Kindle,read';
    await api.post('/api/import/csv', { text, keepNew: true });
    const otherId = db
      .prepare("SELECT id FROM items WHERE title = 'Another Library Label'")
      .pluck()
      .get() as string;
    const keepId = itemOf('harrowfield.epub');
    const { operationId } = (await api.post('/api/merge', { keepId, otherId, choices: {} })).body;
    expect(
      db.prepare("SELECT item_id FROM import_keys WHERE source = 'store_csv'").pluck().get(),
    ).toBe(keepId);
    expect((await api.post('/api/import/csv', { text, keepNew: true })).body).toEqual({
      added: 0,
      attached: 0,
      already: 1,
      skipped: 0,
      links: 0,
    });
    expect((await api.post(`/api/operations/${operationId}/undo`)).status).toBe(200);
    expect(
      db.prepare("SELECT item_id FROM import_keys WHERE source = 'store_csv'").pluck().get(),
    ).toBe(otherId);
  });

  it('keeps the chosen confirmed match when both books were matched to the same provider', async () => {
    const keepId = itemOf('harrowfield.epub');
    const otherId = itemOf('Harrowfield (Anniversary).epub');
    confirmMatch(keepId, 'edition-A');
    confirmMatch(otherId, 'edition-B');
    const response = await api.post('/api/merge', { keepId, otherId, choices: { match: 'other' } });
    expect(response.status).toBe(200);
    expect(
      db.prepare('SELECT identity, match_source_id FROM items WHERE id = ?').get(keepId),
    ).toEqual({ identity: 'accepted', match_source_id: 'edition-B' });
    expect(usedMatches(db, keepId).map((m) => m.sourceId)).toEqual(['edition-B']);
  });
});

describe('undo (§11.4)', () => {
  it('restores the exact shortlist order after reversing its own merge compaction', async () => {
    const ids = [
      'harrowfield.epub',
      'the_salt_ledger.epub',
      'Harrowfield (Anniversary).epub',
      'kestrelmoon.epub',
    ].map(itemOf);
    for (const id of ids) shortlistAdd(db, id);
    const queue = () =>
      db
        .prepare(
          'SELECT item_id FROM user_item WHERE shortlist_position IS NOT NULL ORDER BY shortlist_position',
        )
        .pluck()
        .all();
    const op = (await api.post('/api/merge', { keepId: ids[0], otherId: ids[2], choices: {} })).body
      .operationId;
    expect(queue()).toEqual([ids[0], ids[1], ids[3]]);
    await api.patch(`/api/items/${ids[3]}`, { note: 'Keep this later note' });
    expect((await api.post(`/api/operations/${op}/undo`)).status).toBe(200);
    expect(queue()).toEqual(ids);
    expect(db.prepare('SELECT note FROM user_item WHERE item_id = ?').pluck().get(ids[3])).toBe(
      'Keep this later note',
    );
  });

  it('preserves a later unrelated shortlist reorder when undoing a merge', async () => {
    const ids = [
      'harrowfield.epub',
      'the_salt_ledger.epub',
      'Harrowfield (Anniversary).epub',
      'kestrelmoon.epub',
    ].map(itemOf);
    for (const id of ids) shortlistAdd(db, id);
    const op = (await api.post('/api/merge', { keepId: ids[0], otherId: ids[2], choices: {} })).body
      .operationId;
    shortlistMove(db, ids[3]!, 'up');
    expect((await api.post(`/api/operations/${op}/undo`)).status).toBe(200);
    expect(
      db
        .prepare(
          'SELECT item_id FROM user_item WHERE shortlist_position IS NOT NULL ORDER BY shortlist_position',
        )
        .pluck()
        .all(),
    ).toEqual([ids[0], ids[3], ids[1], ids[2]]);
  });
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

  it('keeps a removed series and its coverage dependencies available for exact undo', async () => {
    const keepId = (
      await api.post('/api/store/items', {
        title: 'Rain Ledger',
        series: 'Rain Cycle',
        number: '1',
        store: 'kindle',
      })
    ).body.itemId;
    const otherId = (
      await api.post('/api/store/items', {
        title: 'Rain Ledger Copy',
        series: 'Mistaken Cycle',
        number: '1',
        store: 'apple_books',
      })
    ).body.itemId;
    const originalSeries = db
      .prepare('SELECT * FROM series WHERE id = (SELECT series_id FROM items WHERE id = ?)')
      .get(otherId) as { id: string };
    db.prepare(
      `INSERT INTO collection_coverage (id, item_id, series_id, first_num, last_num, state, source, created_at, updated_at)
      VALUES ('undo-coverage', ?, ?, 1, 3, 'suggested', 'metron', ?, ?)`,
    ).run(otherId, originalSeries.id, new Date().toISOString(), new Date().toISOString());
    const originalCoverage = db
      .prepare("SELECT * FROM collection_coverage WHERE id = 'undo-coverage'")
      .get();
    const { operationId } = (await api.post('/api/merge', { keepId, otherId, choices: {} })).body;
    // There are no current members, but the retained undo record still depends on this row.
    expect(db.prepare('SELECT * FROM series WHERE id = ?').get(originalSeries.id)).toEqual(
      originalSeries,
    );
    expect((await api.post(`/api/operations/${operationId}/undo`)).status).toBe(200);
    expect(db.prepare('SELECT series_id FROM items WHERE id = ?').pluck().get(otherId)).toBe(
      originalSeries.id,
    );
    expect(
      db.prepare("SELECT * FROM collection_coverage WHERE id = 'undo-coverage'").get(),
    ).toEqual(originalCoverage);
    expect(db.prepare('SELECT * FROM series WHERE id = ?').get(originalSeries.id)).toEqual(
      originalSeries,
    );
  });

  it('refuses undo after a store location is added even if progress was untouched', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    const { operationId } = (await api.post('/api/merge', { keepId: a, otherId: b, choices: {} }))
      .body;
    await api.post(`/api/items/${a}/locations`, { store: 'kobo', readable: true });
    const operation = (await api.get('/api/operations')).body.find(
      (o: { id: string }) => o.id === operationId,
    );
    expect(operation).toMatchObject({ canUndo: false, instead: { kind: 'split', itemId: a } });
    expect((await api.post(`/api/operations/${operationId}/undo`)).status).toBe(409);
    expect((await api.get(`/api/items/${a}/locations`)).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ store: 'kobo', readable: true })]),
    );
  });

  it('refuses undo that would erase an import recorded after the merge', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    const { operationId } = (await api.post('/api/merge', { keepId: a, otherId: b, choices: {} }))
      .body;
    db.prepare(
      'INSERT INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('goodreads', 't:harrowfield', a, new Date().toISOString());
    expect((await api.post(`/api/operations/${operationId}/undo`)).status).toBe(409);
    expect(
      db.prepare("SELECT item_id FROM import_keys WHERE source = 'goodreads'").pluck().get(),
    ).toBe(a);
  });

  it('requires a preview for older undo records that could not track later related edits', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    const { operationId } = (await api.post('/api/merge', { keepId: a, otherId: b, choices: {} }))
      .body;
    const stamp = db.prepare('SELECT updated_at FROM user_item WHERE item_id = ?').pluck().get(a);
    db.prepare('UPDATE operations SET stamps = ? WHERE id = ?').run(
      JSON.stringify({ [a]: stamp }),
      operationId,
    );
    const operation = (await api.get('/api/operations')).body.find(
      (o: { id: string }) => o.id === operationId,
    );
    expect(operation).toMatchObject({
      canUndo: false,
      blockedBecause: expect.stringContaining('older undo record'),
      instead: { kind: 'split' },
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

  it('moves the confirmed match and import identity with reading history on a split', async () => {
    const a = itemOf('harrowfield.epub');
    const b = itemOf('Harrowfield (Anniversary).epub');
    confirmMatch(a, 'edition-A');
    confirmMatch(b, 'edition-B');
    db.prepare(
      'INSERT INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('goodreads', 't:confirmed-edition', b, new Date().toISOString());
    await api.post('/api/merge', { keepId: a, otherId: b, choices: { match: 'other' } });
    const response = await api.post('/api/split', {
      itemId: a,
      fileIds: [fileId('Harrowfield (Anniversary).epub')],
      ownerData: 'move',
    });
    expect(response.status).toBe(200);
    const { newItemId, operationId } = response.body;
    expect(
      db.prepare('SELECT identity, match_source_id FROM items WHERE id = ?').get(newItemId),
    ).toEqual({ identity: 'accepted', match_source_id: 'edition-B' });
    expect(usedMatches(db, newItemId).map((m) => m.sourceId)).toEqual(['edition-B']);
    expect(
      db.prepare("SELECT item_id FROM import_keys WHERE source = 'goodreads'").pluck().get(),
    ).toBe(newItemId);
    expect((await api.post(`/api/operations/${operationId}/undo`)).status).toBe(200);
    expect(
      db.prepare("SELECT item_id FROM import_keys WHERE source = 'goodreads'").pluck().get(),
    ).toBe(a);
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
