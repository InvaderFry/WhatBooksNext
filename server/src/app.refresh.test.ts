import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { KEPT_PREVIOUS } from './identify/lookups.ts';
import { createStoreItem } from './lib/store.ts';
import { setSecret } from './sources/index.ts';
import type { Fetcher } from './sources/types.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';
import { todayLocal } from './util.ts';

/**
 * Ratings plan stage 4: automatic refresh and starting fresh, against invented Open Library
 * answers and a clock the tests move forward. Never the network.
 */

const PORT = 4818;
const HOST = `localhost:${PORT}`;
const DAY = 86_400_000;

let db: DB;
let made: ReturnType<typeof createApp>;
let clock: number;
let requests: string[];
let failing: boolean;
let gate: Promise<void> | null;
/** Open Library's docs by lowercase title. */
let answers: Record<string, object[]>;

const doc = (key: string, title: string, author: string, rating?: [number, number]) => ({
  key: `/works/${key}`,
  title,
  author_name: [author],
  first_publish_year: 1998,
  ...(rating ? { ratings_average: rating[0], ratings_count: rating[1] } : {}),
});

const fetcher: Fetcher = async (url) => {
  requests.push(url);
  if (gate) await gate;
  if (failing) return new Response('down', { status: 503 });
  const u = new URL(url);
  if (u.hostname === 'openlibrary.org') {
    const docs = answers[(u.searchParams.get('title') ?? '').toLowerCase()] ?? [];
    return new Response(JSON.stringify({ numFound: docs.length, docs }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('{}', { status: 404 });
};

function start(opts: { demo?: boolean; batch?: number } = {}) {
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    fetcher,
    demo: opts.demo,
    clock: () => clock,
    refreshBatch: opts.batch,
  });
}

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
};

beforeEach(async () => {
  clock = Date.now();
  requests = [];
  failing = false;
  gate = null;
  answers = {};
  db = await memoryDb();
  start();
});

afterEach(async () => {
  await made.close();
});

const book = (title = 'Rain Ledger') =>
  createStoreItem(db, { title, author: 'Ola Pennant', store: 'kindle' });

const state = (id: string) =>
  db.prepare("SELECT * FROM lookup_state WHERE item_id = ? AND source = 'openlibrary'").get(id) as {
    outcome: string;
    error: string | null;
    accepted_source_id: string | null;
    rival_source_id: string | null;
    last_answer_at: string | null;
    failure_count: number;
  };

const online = async (id: string) => (await api.get(`/api/items/${id}/online`)).body;

/** A book looked up once and accepted as /works/W1, 50 ratings (supported, so settled). */
async function acceptedBook() {
  answers['rain ledger'] = [doc('W1', 'Rain Ledger', 'Ola Pennant', [4.1, 50])];
  const id = book();
  await made.refresher.check();
  expect(state(id).accepted_source_id).toBe('/works/W1');
  return id;
}

describe('remembering the app’s own choice', () => {
  it('keeps the match it accepted when a refresh prefers another record, and asks in Needs review', async () => {
    const id = await acceptedBook();
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    clock += 100 * DAY;
    const batch = await made.refresher.check();
    expect(batch?.books).toBe(1);
    expect(state(id)).toMatchObject({
      accepted_source_id: '/works/W1',
      rival_source_id: '/works/W2',
    });
    expect((await online(id)).community).toMatchObject({ sourceId: '/works/W1', votes: 50 });
    const review = (await api.get('/api/review')).body.rows.find(
      (r: { kind: string }) => r.kind === 'check_match',
    );
    expect(review.items[0].id).toBe(id);
    expect(review.candidates.map((c: { sourceId: string }) => c.sourceId)).toEqual([
      '/works/W1',
      '/works/W2',
    ]);
  });

  it('keeps it through a re-score after the matching rules change', async () => {
    const id = await acceptedBook();
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    clock += 100 * DAY;
    await made.refresher.check();
    // An older MATCH_VERSION: the next run re-scores from the cache, without new requests.
    db.prepare('UPDATE lookup_state SET version = version - 1').run();
    const before = requests.length;
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    expect(requests.length).toBe(before);
    expect((await online(id)).community.sourceId).toBe('/works/W1');
  });

  it('lets “Look up again” choose afresh and says what changed', async () => {
    const id = await acceptedBook();
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    const r = await api.post(`/api/items/${id}/lookup`, {});
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual(['Rating now from Open Library, 900 ratings.']);
    expect(state(id)).toMatchObject({ accepted_source_id: '/works/W2', rival_source_id: null });
    expect((await online(id)).community.sourceId).toBe('/works/W2');
  });

  it('keeps confirmed and rejected decisions when starting fresh', async () => {
    const id = await acceptedBook();
    await api.post(`/api/items/${id}/match`, {
      action: 'confirm',
      source: 'openlibrary',
      sourceId: '/works/W1',
    });
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    await api.post(`/api/items/${id}/lookup`, {});
    expect((await online(id)).community.sourceId).toBe('/works/W1');

    const other = book('Salt Orchard');
    answers['salt orchard'] = [doc('S1', 'Salt Orchard', 'Ola Pennant', [4, 40])];
    await api.post(`/api/items/${other}/lookup`, {});
    await api.post(`/api/items/${other}/match`, {
      action: 'reject',
      source: 'openlibrary',
      sourceId: '/works/S1',
    });
    expect(state(other).accepted_source_id).toBeNull();
    await api.post(`/api/items/${other}/lookup`, {});
    expect((await online(other)).community).toBeNull();
  });
});

describe('what a background refresh may change', () => {
  it('updates the same record’s rating, and a removed rating becomes unrated', async () => {
    const id = await acceptedBook();
    answers['rain ledger'] = [doc('W1', 'Rain Ledger', 'Ola Pennant', [4.3, 80])];
    clock += 100 * DAY;
    await made.refresher.check();
    expect((await online(id)).community).toMatchObject({ votes: 80, raw: 4.3 });
    answers['rain ledger'] = [doc('W1', 'Rain Ledger', 'Ola Pennant')];
    clock += 100 * DAY;
    await made.refresher.check();
    expect((await online(id)).community).toBeNull();
    expect(state(id).accepted_source_id).toBe('/works/W1');
  });

  it('keeps the previous result when a refresh fails, and tries again after a day', async () => {
    const id = await acceptedBook();
    const answered = state(id).last_answer_at;
    clock += 100 * DAY;
    failing = true;
    await made.refresher.check();
    expect(state(id)).toMatchObject({
      outcome: 'failed',
      failure_count: 1,
      last_answer_at: answered,
    });
    expect((await online(id)).community).toMatchObject({ sourceId: '/works/W1', votes: 50 });
    expect((await online(id)).refresh.failed).toEqual(['Open Library']);
    failing = false;
    // Lookups record the real time; the retry is due a day after it.
    clock = Date.now();
    expect(made.refresher.dueItemIds()).toEqual([]);
    clock += 1.2 * DAY;
    expect(made.refresher.dueItemIds()).toEqual([id]);
    await made.refresher.check();
    expect(state(id)).toMatchObject({ outcome: 'matched', failure_count: 0 });
  });

  it('keeps the previous result when the source no longer finds the book clearly', async () => {
    const id = await acceptedBook();
    answers['rain ledger'] = [];
    clock += 100 * DAY;
    await made.refresher.check();
    expect(state(id)).toMatchObject({ outcome: 'matched', error: KEPT_PREVIOUS, failure_count: 1 });
    expect((await online(id)).community.sourceId).toBe('/works/W1');
  });

  it('asks weekly about a book once the owner starts reading it', async () => {
    const id = await acceptedBook();
    clock += 8 * DAY;
    expect(made.refresher.dueItemIds()).toEqual([]);
    await api.patch(`/api/items/${id}`, { progress: 'into_it' });
    expect(made.refresher.dueItemIds()).toEqual([id]);
  });
});

describe('review fixes', () => {
  it('keeps an unconfirmed match through a failure and then an empty answer', async () => {
    // A near title: found, but not certainly (provisional).
    answers['rain ledger'] = [doc('W1', 'Rain Ledger: A Novel of Tides', 'Ola Pennant', [4.1, 50])];
    const id = book();
    await made.refresher.check();
    expect(state(id).outcome).toBe('provisional');
    clock += 100 * DAY;
    failing = true;
    await made.refresher.check();
    expect(state(id).outcome).toBe('failed');
    failing = false;
    answers['rain ledger'] = [];
    clock += 2 * DAY;
    await made.refresher.check();
    expect(state(id)).toMatchObject({
      outcome: 'provisional',
      error: KEPT_PREVIOUS,
      failure_count: 2,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) FROM item_matches WHERE item_id = ? AND source = 'openlibrary'")
        .pluck()
        .get(id),
    ).toBe(1);
  });

  it('remembers an accepted match kept under a failed lookup from before the update', async () => {
    const id = await acceptedBook();
    // As an older database had it: the match accepted, the latest lookup failed, nothing remembered.
    db.prepare(
      `UPDATE lookup_state SET outcome = 'failed', error = 'down', accepted_source_id = NULL,
         last_answer_at = NULL WHERE item_id = ?`,
    ).run(id);
    await made.close();
    start();
    expect(state(id)).toMatchObject({ accepted_source_id: '/works/W1', last_answer_at: null });
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    clock += 100 * DAY;
    await made.refresher.check();
    expect(state(id)).toMatchObject({
      accepted_source_id: '/works/W1',
      rival_source_id: '/works/W2',
    });
  });

  it('lets a corrected title choose again even when the first lookup after it fails', async () => {
    const id = await acceptedBook();
    expect((await api.patch(`/api/items/${id}`, { titleOverride: 'Salt Orchard' })).status).toBe(
      200,
    );
    failing = true;
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    expect(state(id)).toMatchObject({ outcome: 'failed', accepted_source_id: null });
    failing = false;
    answers['salt orchard'] = [doc('S1', 'Salt Orchard', 'Ola Pennant', [4, 40])];
    await api.post('/api/lookups', {});
    await made.lookups.wait();
    expect(state(id).accepted_source_id).toBe('/works/S1');
    expect((await online(id)).community.sourceId).toBe('/works/S1');
  });

  it('never asks a source past its automatic share, even as a comic partner', async () => {
    setSecret(db, 'metron_token', 'invented-metron-token');
    setSecret(db, 'comicvine_key', 'invented-comicvine-key');
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('refreshUsage:metron', ?, '')",
    ).run(JSON.stringify({ day: todayLocal(), count: 1000 }));
    const id = createStoreItem(db, { title: 'Copperline', store: 'kindle', kind: 'comic' });
    db.prepare("UPDATE items SET issue_label = '48', series_hint = 'Copperline' WHERE id = ?").run(
      id,
    );
    for (const source of ['metron', 'comicvine'])
      db.prepare(
        `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome,
           last_answer_at) VALUES (?, ?, 0, '{}', '2020-01-01T00:00:00Z', 'none', '2020-01-01T00:00:00Z')`,
      ).run(id, source);
    await made.refresher.check();
    expect(requests.some((u) => u.includes('metron'))).toBe(false);
  });
});

describe('how much, and when', () => {
  it('keeps each batch to its request budget, and carries on at the next check', async () => {
    // Open Library is asked once a second, so the test uses a budget of 4 instead of 25.
    await made.close();
    start({ batch: 4 });
    for (let i = 0; i < 6; i++) {
      const title = `Invented Title ${i}`;
      answers[title.toLowerCase()] = [doc(`N${i}`, title, 'Ola Pennant', [4, 30])];
      book(title);
    }
    const first = await made.refresher.check();
    expect(first?.requests).toBe(4);
    expect(requests.length).toBe(4);
    const second = await made.refresher.check();
    expect(second?.requests).toBe(2);
    expect((await made.refresher.check())?.requests).toBe(0);
  });

  it('stays idle when turned off or paused, and during a lookup run or a scan', async () => {
    book();
    expect((await api.patch('/api/settings/refresh', { enabled: false })).status).toBe(200);
    expect(await made.refresher.check()).toBeNull();
    await api.patch('/api/settings/refresh', { enabled: true, paused: true });
    expect(await made.refresher.check()).toBeNull();
    expect((await api.get('/api/refresh')).body).toMatchObject({ enabled: true, paused: true });
    await api.patch('/api/settings/refresh', { paused: false });
    expect(requests).toEqual([]);

    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    made.lookups.start();
    expect(await made.refresher.check()).toBeNull();
    release();
    gate = null;
    await made.lookups.wait();

    const drive = tempDir('wbn-refresh-');
    try {
      writeFiles(drive, { 'Invented Scan.epub': 2000 });
      await made.close();
      made = createApp({
        db,
        platform: fakePlatformWithDrives({ drive }),
        port: PORT,
        dataDir: null,
        snapshotDir: null,
        fetcher,
        autoLookups: false,
        clock: () => clock,
      });
      await api.post('/api/folders', { path: drive });
      await api.post('/api/scan', {});
      expect(made.scans.isRunning()).toBe(true);
      expect(await made.refresher.check()).toBeNull();
      await made.scans.wait();
    } finally {
      fs.rmSync(drive, { recursive: true, force: true });
    }
  });

  it('never runs in the demo', async () => {
    await made.close();
    start({ demo: true });
    expect(await made.refresher.check()).toBeNull();
    expect((await api.get('/api/refresh')).body.enabled).toBe(false);
  });

  it('pauses a source whose daily allowance is used up until the next day', async () => {
    setSecret(db, 'hardcover_token', 'invented-token-0123456789abcdef');
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('hardcoverUsage', ?, '')",
    ).run(JSON.stringify({ day: todayLocal(), count: 4900 }));
    answers['rain ledger'] = [doc('W1', 'Rain Ledger', 'Ola Pennant', [4.1, 50])];
    const id = book();
    await made.refresher.check();
    const hc = db
      .prepare("SELECT * FROM lookup_state WHERE item_id = ? AND source = 'hardcover'")
      .get(id) as { outcome: string; failure_count: number; next_eligible_at: string };
    expect(hc).toMatchObject({ outcome: 'failed', failure_count: 0 });
    expect(Date.parse(hc.next_eligible_at)).toBeGreaterThan(Date.now());
    const source = (await api.get('/api/refresh')).body.sources.find(
      (s: { source: string }) => s.source === 'hardcover',
    );
    expect(source.pausedBecause).toMatch(/tomorrow/);
    // Open Library carried on.
    expect(state(id).outcome).toBe('matched');
  });

  it('keeps automatic work to a fifth of a daily allowance', async () => {
    setSecret(db, 'hardcover_token', 'invented-token-0123456789abcdef');
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('refreshUsage:hardcover', ?, '')",
    ).run(JSON.stringify({ day: todayLocal(), count: 1000 }));
    book();
    await made.refresher.check();
    expect(requests.some((u) => u.includes('hardcover'))).toBe(false);
    expect(requests.some((u) => u.includes('openlibrary'))).toBe(true);
    const diag = (await api.get('/api/diagnostics')).body.refresh;
    expect(diag.sources.find((s: { source: string }) => s.source === 'hardcover')).toMatchObject({
      automaticToday: 1000,
      automaticAllowance: 1000,
    });
  });
});

describe('Look up all books again', () => {
  it('needs a confirmation, says roughly what it costs, and looks up every book', async () => {
    const id = await acceptedBook();
    expect((await api.post('/api/lookups/fresh', {})).status).toBe(400);
    expect((await api.get('/api/lookups/fresh')).body.estimate).toMatchObject({
      books: 1,
      requests: 1,
    });
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    const r = await api.post('/api/lookups/fresh', { confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.status.label).toBe('fresh');
    // Automatic refresh waits while it runs.
    expect(await made.refresher.check()).toBeNull();
    await made.lookups.wait();
    expect(state(id).accepted_source_id).toBe('/works/W2');
    expect((await api.get('/api/refresh')).body.fresh).toBeNull();
  });

  it('can be cancelled, leaving books it hadn’t reached as they were', async () => {
    const id = await acceptedBook();
    answers['salt orchard'] = [doc('S1', 'Salt Orchard', 'Ola Pennant', [4, 40])];
    const other = book('Salt Orchard');
    await made.refresher.check();
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    answers['salt orchard'] = [];
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    await api.post('/api/lookups/fresh', { confirm: true });
    await expect.poll(() => requests.length, { timeout: 5000 }).toBeGreaterThan(2);
    await api.post('/api/lookups/cancel', {});
    release();
    gate = null;
    await made.lookups.wait();
    expect((await api.get('/api/refresh')).body.fresh).toBeNull();
    // The book it was on finishes; the one it hadn't reached keeps its old answer.
    expect(state(id).accepted_source_id).toBe('/works/W2');
    expect(state(other).accepted_source_id).toBe('/works/S1');
  });

  it('carries on after the app is closed and started again', async () => {
    await acceptedBook();
    answers['salt orchard'] = [doc('S1', 'Salt Orchard', 'Ola Pennant', [4, 40])];
    const other = book('Salt Orchard');
    await made.refresher.check();
    answers['rain ledger'] = [doc('W2', 'Rain Ledger', 'Ola Pennant', [3.2, 900])];
    answers['salt orchard'] = [doc('S2', 'Salt Orchard', 'Ola Pennant', [4.4, 70])];
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    await api.post('/api/lookups/fresh', { confirm: true });
    await expect.poll(() => requests.length, { timeout: 5000 }).toBeGreaterThan(2);
    // Closed while on the first book: that one finishes, the second waits for the next start.
    const closing = made.close();
    release();
    gate = null;
    await closing;
    expect(state(other).accepted_source_id).toBe('/works/S1');
    start();
    expect((await api.get('/api/refresh')).body.fresh).toMatchObject({ waitingForTomorrow: false });
    await made.refresher.check();
    expect(made.lookups.status()?.label).toBe('fresh');
    await made.lookups.wait();
    expect(state(other).accepted_source_id).toBe('/works/S2');
    expect((await api.get('/api/refresh')).body.fresh).toBeNull();
  });
});
