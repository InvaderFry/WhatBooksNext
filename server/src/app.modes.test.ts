import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { createBackup, restoreBackup, validateBackup } from './lib/backup.ts';
import { applyUserPatch } from './lib/progress.ts';
import { createStoreItem } from './lib/store.ts';
import { syncSeries } from './identify/series.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Milestone 5 routes: modes, Tune, topics, Still reading?, Still relevant? and bulk triage. */

const HOST = 'localhost:4818';
let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  put: (url: string, body: object) => request(made.app).put(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
};

beforeEach(async () => {
  drive = tempDir('wbn-m5-drive-');
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: 4818,
    dataDir: null,
    snapshotDir: null,
    fetcher: async () => new Response('{}', { status: 404 }),
  });
});

afterEach(async () => {
  await made.close();
  fs.rmSync(drive, { recursive: true, force: true });
});

const book = (title: string, kind = 'fiction', author = `Writer of ${title}`) =>
  createStoreItem(db, { title, author, kind, store: 'kindle' });

describe('What next modes', () => {
  it('serves every mode with its rule, and an honest empty case', async () => {
    book('An Invented Voyage');
    for (const view of [
      'read_next',
      'continue',
      'next_in_series',
      'one_sitting',
      'waiting',
      'hidden_gems',
      'classics',
      'still_relevant',
      'mood',
      'surprise',
    ]) {
      const r = await api.get(`/api/next?view=${view}`);
      expect(r.status).toBe(200);
      expect(r.body.view).toBe(view);
      expect(r.body.modes.find((m: { id: string }) => m.id === view).description).toBeTruthy();
      if (r.body.cards.length === 0) expect(r.body.empty).toBeTruthy();
    }
    expect((await api.get('/api/next?view=nonsense')).body.view).toBe('read_next');
  });

  it('lists books in progress in Continue reading, shortlist first', async () => {
    const a = book('Invented Alpha');
    const b = book('Invented Beta');
    await api.patch(`/api/items/${a}`, { progress: 'nearly_done' });
    await api.patch(`/api/items/${b}`, { progress: 'sampled' });
    await api.post('/api/shortlist', { itemId: b });
    const r = await api.get('/api/next?view=continue');
    expect(r.body.cards.map((c: { id: string }) => c.id)).toEqual([b, a]);
  });

  it('applies Mood as a re-weighting and reports the mood back', async () => {
    book('An Invented Romance', 'fiction');
    const learn = book('An Invented History', 'nonfiction');
    const r = await api.get('/api/next?view=mood&mood=learn');
    expect(r.body.situation.mood).toBe('learn');
    expect(r.body.cards[0].id).toBe(learn);
    expect(r.body.cards).toHaveLength(2);
  });

  it('filters Complete stories only and counts what it left out', async () => {
    createStoreItem(db, {
      title: 'Invented Saga 1',
      series: 'Invented Saga',
      number: '1',
      store: 'kindle',
    });
    book('A Standalone Invention');
    syncSeries(db);
    const r = await api.get('/api/next?complete=1');
    expect(r.body.situation.complete).toBe(true);
    expect(r.body.cards.map((c: { title: string }) => c.title)).toEqual(['A Standalone Invention']);
    expect(r.body.leftOut).toEqual({ ongoing: 0, unknown: 1, missing: 0 });
  });

  it('keeps Surprise me from repeating the previous pick', async () => {
    const a = book('Invented One');
    const b = book('Invented Two');
    for (let k = 0; k < 5; k++) {
      const r = await api.get(`/api/next?view=surprise&previous=${a}`);
      expect(r.body.cards.map((c: { id: string }) => c.id)).toEqual([b]);
    }
  });
});

describe('Tune and taste', () => {
  it('saves weights, uses them, and resets to the starting values', async () => {
    const t = await api.get('/api/tune');
    expect(t.body.weights).toEqual(t.body.defaults);
    expect(t.body.explain.rating.label).toBe('Rating');
    expect(t.body.taste).toMatchObject({ active: false, threshold: 10, minGroups: 3 });

    const r = await api.put('/api/tune', { weights: { recency: 0.5 }, strength: 'high' });
    expect(r.status).toBe(200);
    expect((await api.get('/api/tune')).body).toMatchObject({
      weights: { recency: 0.5, rating: 0.35 },
      strength: 'high',
    });
    expect((await api.put('/api/tune', { weights: { rating: 2 } })).status).toBe(400);
    expect((await api.put('/api/tune', { weights: { magic: 1 } })).status).toBe(400);
    expect((await api.put('/api/tune', { strength: 'max' })).status).toBe(400);

    await api.post('/api/tune/reset');
    const after = (await api.get('/api/tune')).body;
    expect(after.weights).toEqual(after.defaults);
    // Reset is for the weights; the taste setting stays the owner's choice.
    expect(after.strength).toBe('high');
  });

  it('switches taste on once ten outcomes from three authors are recorded', async () => {
    for (let k = 0; k < 10; k++) {
      const id = book(`Invented Finished ${k}`, 'fiction', `Author ${k % 3}`);
      applyUserPatch(db, id, { progress: 'finished', rating: 9 });
    }
    expect((await api.get('/api/next')).body.taste.on).toBe(true);
    await api.put('/api/tune', { strength: 'off' });
    expect((await api.get('/api/next')).body.taste.on).toBe(false);
  });

  it('keeps Tune, taste strength and topics in the backup', async () => {
    await api.put('/api/tune', { weights: { taste: 0.3 }, strength: 'low' });
    await api.put('/api/settings/topics', { topics: ['Rust'] });
    const backup = createBackup(db);
    await api.post('/api/tune/reset');
    await api.put('/api/settings/topics', { topics: [] });
    await restoreBackup(db, validateBackup(db, JSON.parse(JSON.stringify(backup))), null);
    expect((await api.get('/api/tune')).body).toMatchObject({
      weights: { taste: 0.3 },
      strength: 'low',
    });
    expect((await api.get('/api/settings/topics')).body.topics).toEqual(['Rust']);
  });
});

describe('Topic interests', () => {
  it('saves a tidy list and refuses nonsense', async () => {
    const r = await api.put('/api/settings/topics', { topics: [' Rust ', 'rust', 'Go', ''] });
    expect(r.body.topics).toEqual(['Rust', 'Go']);
    expect((await api.put('/api/settings/topics', { topics: 'Rust' })).status).toBe(400);
    expect((await api.put('/api/settings/topics', { topics: ['x'.repeat(41)] })).status).toBe(400);
  });

  it('shows a topic’s books, reference included, when the owner picks it', async () => {
    await api.put('/api/settings/topics', { topics: ['Rust'] });
    const ref = book('The Invented Rust Reference', 'tech');
    await api.patch(`/api/items/${ref}`, { referenceOverride: true });
    book('An Invented Voyage');
    expect((await api.get('/api/next')).body.cards.map((c: { id: string }) => c.id)).not.toContain(
      ref,
    );
    const r = await api.get('/api/next?topic=Rust');
    expect(r.body.cards.map((c: { id: string }) => c.id)).toEqual([ref]);
  });
});

describe('Still reading? (§13.6)', () => {
  const longAgo = (id: string) =>
    db
      .prepare('UPDATE user_item SET progress_at = ? WHERE item_id = ?')
      .run('2020-01-01T10:00:00.000Z', id);

  it('gathers stale books into one digest and handles each answer', async () => {
    const ids = ['A', 'B', 'C', 'D'].map((x) => book(`Invented Stalled ${x}`));
    for (const id of ids) {
      await api.patch(`/api/items/${id}`, { progress: 'halfway' });
      longAgo(id);
    }
    expect((await api.get('/api/next')).body.stillReading).toBe(4);
    expect((await api.get('/api/still-reading')).body.items).toHaveLength(4);

    await api.post(`/api/still-reading/${ids[0]}`, { action: 'still' });
    await api.post(`/api/still-reading/${ids[1]}`, { action: 'snooze' });
    await api.post(`/api/still-reading/${ids[2]}`, { action: 'not_started' });
    await api.post(`/api/still-reading/${ids[3]}`, { action: 'dnf', dnfReason: 'not_now' });
    expect((await api.get('/api/still-reading')).body.items).toEqual([]);
    const progress = (id: string) =>
      db.prepare('SELECT progress, dnf_reason FROM user_item WHERE item_id = ?').get(id);
    expect(progress(ids[0]!)).toEqual({ progress: 'halfway', dnf_reason: null });
    expect(progress(ids[1]!)).toEqual({ progress: 'halfway', dnf_reason: null });
    expect(progress(ids[2]!)).toEqual({ progress: 'not_started', dnf_reason: null });
    expect(progress(ids[3]!)).toEqual({ progress: 'dnf', dnf_reason: 'not_now' });
    expect((await api.post(`/api/still-reading/${ids[0]}`, { action: 'x' })).status).toBe(400);
  });
});

describe('Still relevant? actions', () => {
  it('Want, reference and Never take a book off the list; Decide later moves it to the end', async () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((x) => book(`Invented Tech ${x}`, 'tech'));
    const list = async () =>
      (await api.get('/api/next?view=still_relevant')).body.cards.map((x: { id: string }) => x.id);
    expect(await list()).toEqual([a, b, c, d]);
    await api.post(`/api/items/${a}/relevance`, { action: 'later' });
    expect(await list()).toEqual([b, c, d, a]);
    await api.post(`/api/items/${b}/relevance`, { action: 'want' });
    await api.post(`/api/items/${c}/relevance`, { action: 'reference' });
    await api.post(`/api/items/${d}/relevance`, { action: 'never' });
    expect(await list()).toEqual([a]);
    expect(
      db.prepare('SELECT reference_override FROM user_item WHERE item_id = ?').pluck().get(c),
    ).toBe(1);
    expect((await api.post(`/api/items/${a}/relevance`, { action: 'x' })).status).toBe(400);
  });
});

describe('Triage (§13.5)', () => {
  it('previews bulk Already read, applies it with unknown dates, and undoes it exactly', async () => {
    const a = book('Invented A');
    const b = book('Invented B');
    await api.patch(`/api/items/${b}`, { progress: 'halfway' });
    await api.post('/api/shortlist', { itemId: b });
    const before = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(b);

    const p = await api.post('/api/triage/bulk', { ids: [a, b], action: 'read' });
    expect(p.body.preview).toMatchObject({
      count: 2,
      changes: 2,
      inProgress: [{ id: b, progress: 'halfway' }],
      shortlisted: [{ id: b }],
    });
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(b)).toBe(
      'halfway',
    );

    const done = await api.post('/api/triage/bulk', {
      ids: [a, b],
      action: 'read',
      preview: false,
    });
    expect(done.body.done).toBe(2);
    expect(
      db
        .prepare(
          'SELECT progress, finished_on, finished_precision FROM user_item WHERE item_id = ?',
        )
        .get(a),
    ).toEqual({ progress: 'finished', finished_on: null, finished_precision: 'unknown' });

    const u = await api.post('/api/triage/bulk/undo', { undo: done.body.undo });
    expect(u.body).toEqual({ restored: 2, skipped: 0 });
    expect(db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(b)).toEqual(before);
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
      'not_started',
    );
    expect((await api.post('/api/triage/bulk/undo', { undo: done.body.undo })).status).toBe(404);
  });

  it('leaves alone a book edited after a bulk Never when undoing', async () => {
    const a = book('Invented A');
    const b = book('Invented B');
    const done = await api.post('/api/triage/bulk', {
      ids: [a, b],
      action: 'never',
      preview: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await api.patch(`/api/items/${a}`, { triage: 'want' });
    const u = await api.post('/api/triage/bulk/undo', { undo: done.body.undo });
    expect(u.body).toEqual({ restored: 1, skipped: 1 });
    expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
      'want',
    );
    expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(b)).toBeNull();
  });

  it('undoes a one-at-a-time Want back to exactly how the book was', async () => {
    const a = book('Invented A');
    await api.patch(`/api/items/${a}`, { triage: 'maybe' });
    const before = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(a);
    const done = await api.post('/api/triage/one', { id: a, action: 'want' });
    expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
      'want',
    );
    const u = await api.post('/api/triage/undo', { undo: done.body.undo });
    expect(u.body).toEqual({ restored: 1, skipped: 0 });
    expect(db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(a)).toEqual(before);
    expect((await api.post('/api/triage/undo', { undo: done.body.undo })).status).toBe(404);
  });

  it('keeps earlier progress when a one-at-a-time Already read is undone', async () => {
    const a = book('Invented A');
    await api.patch(`/api/items/${a}`, { progress: 'halfway' });
    const done = await api.post('/api/triage/one', { id: a, action: 'read' });
    expect(
      db.prepare('SELECT progress, finished_on FROM user_item WHERE item_id = ?').get(a),
    ).toEqual({ progress: 'finished', finished_on: null });
    await api.post('/api/triage/undo', { undo: done.body.undo });
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
      'halfway',
    );
  });

  it('leaves a newer decision alone when a one-at-a-time triage is undone', async () => {
    const a = book('Invented A');
    const done = await api.post('/api/triage/one', { id: a, action: 'want' });
    await new Promise((r) => setTimeout(r, 5));
    // Decided again elsewhere (another tab, the book page) after the Want.
    await api.patch(`/api/items/${a}`, { triage: 'never' });
    const u = await api.post('/api/triage/undo', { undo: done.body.undo });
    expect(u.body).toEqual({ restored: 0, skipped: 1 });
    expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
      'never',
    );
  });

  it('leaves a newer decision alone even when it has the same timestamp as the triage', async () => {
    // Two edits in the same millisecond (e.g. two tabs at once) share `updated_at`.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-14T12:00:00.000Z') });
    try {
      const a = book('Invented A');
      const done = await api.post('/api/triage/one', { id: a, action: 'want' });
      await api.patch(`/api/items/${a}`, { triage: 'never' });
      const u = await api.post('/api/triage/undo', { undo: done.body.undo });
      expect(u.body).toEqual({ restored: 0, skipped: 1 });
      expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
        'never',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves alone a book edited in the same millisecond as a bulk Never', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-14T12:00:00.000Z') });
    try {
      const a = book('Invented A');
      const b = book('Invented B');
      const done = await api.post('/api/triage/bulk', {
        ids: [a, b],
        action: 'never',
        preview: false,
      });
      await api.patch(`/api/items/${a}`, { triage: 'want' });
      const u = await api.post('/api/triage/undo', { undo: done.body.undo });
      expect(u.body).toEqual({ restored: 1, skipped: 1 });
      expect(db.prepare('SELECT triage FROM user_item WHERE item_id = ?').pluck().get(a)).toBe(
        'want',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unknown one-at-a-time action or book', async () => {
    const a = book('Invented A');
    expect((await api.post('/api/triage/one', { id: a, action: 'skip' })).status).toBe(400);
    expect((await api.post('/api/triage/one', { id: 'nope', action: 'want' })).status).toBe(404);
  });

  it('offers new arrivals and a folder’s books, and counts what the last scan added', async () => {
    writeFiles(drive, { 'first/old-book.epub': makeEpub({ title: 'Invented Old Book' }) });
    await api.post('/api/folders', { path: drive });
    await api.post('/api/scan', {});
    await made.scans.wait();
    // Straight after the first scan: what the next scan finds is still genuinely new.
    await new Promise((r) => setTimeout(r, 5));
    writeFiles(drive, { 'second/new-book.epub': makeEpub({ title: 'Invented New Book' }) });
    await api.post('/api/scan', {});
    await made.scans.wait();

    const all = (await api.get('/api/triage?limit=50')).body;
    expect(all.remaining).toBe(2);
    expect(all.newArrivals).toBe(1);
    expect(all.lastScan.newItems).toBe(1);
    const fresh = (await api.get('/api/triage?source=new&limit=50')).body;
    expect(fresh.items.map((i: { title: string }) => i.title)).toEqual(['Invented New Book']);
    const folder = all.folders[0];
    expect(folder.untriaged).toBe(2);
    const inFolder = (await api.get(`/api/triage?source=folder&folder=${folder.id}`)).body;
    expect(inFolder.remaining).toBe(2);
    expect((await api.get('/api/triage?source=folder')).status).toBe(400);
  });

  it('counts nothing as new until the folder’s first scan has finished', async () => {
    writeFiles(drive, { 'a/one.epub': makeEpub({ title: 'Invented One' }) });
    await api.post('/api/folders', { path: drive });
    await api.post('/api/scan', {});
    await made.scans.wait();
    // As if that first scan had been cancelled: no complete scan is recorded yet.
    db.prepare('UPDATE folders SET first_complete_scan_at = NULL').run();
    await new Promise((r) => setTimeout(r, 5));
    writeFiles(drive, { 'b/two.epub': makeEpub({ title: 'Invented Two' }) });
    await api.post('/api/scan', {});
    await made.scans.wait();
    // This scan is the first complete one: both books came with the folder.
    expect((await api.get('/api/triage?limit=50')).body.newArrivals).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    writeFiles(drive, { 'c/three.epub': makeEpub({ title: 'Invented Three' }) });
    await api.post('/api/scan', {});
    await made.scans.wait();
    expect((await api.get('/api/triage?limit=50')).body.newArrivals).toBe(1);
  });
});
