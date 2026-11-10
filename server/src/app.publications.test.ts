import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { applyIdentity, matchFactsFor } from './identify/lookups.ts';
import { buildQuery, MATCH_VERSION } from './identify/match.ts';
import { syncSeries } from './identify/series.ts';
import { createBackup, restoreBackup, validateBackup } from './lib/backup.ts';
import { createStoreItem } from './lib/store.ts';
import { publicationSeries, refreshPublications } from './lib/publications.ts';
import { ensureUserRow } from './lib/progress.ts';
import { setSecret } from './sources/index.ts';
import { memoryDb, fakePlatformWithDrives } from './testing/helpers.ts';

let db: DB;
let made: ReturnType<typeof createApp>;
let first: string, second: string, seriesId: string;
let fail = false,
  ambiguous = false,
  gate: Promise<void> | null = null;
let calls: string[];
const post = (url: string, body = {}) =>
  request(made.app).post(url).set('Host', 'localhost:4818').send(body);
const get = (url: string) => request(made.app).get(url).set('Host', 'localhost:4818');
const catalogue = () => ({
  data: {
    series_by_pk: {
      id: 700,
      name: 'Copper Orchards',
      book_series: [1, 2, 3, 4].map((n) => ({
        position: n,
        compilation: false,
        book: {
          id: 500 + n,
          title: `Copper Orchards Vol. ${n}`,
          release_date: '2024-01-01',
          canonical_id: null,
          is_partial_book: false,
        },
      })),
    },
  },
});

beforeEach(async () => {
  db = await memoryDb();
  fail = false;
  ambiguous = false;
  calls = [];
  gate = null;
  setSecret(db, 'hardcover_token', 'invented-token');
  for (const n of [1, 2]) {
    const id = createStoreItem(db, {
      title: `Copper Orchards Vol. ${n}`,
      author: 'Ada Fen',
      kind: 'comic',
      series: 'Copper Orchards',
      number: String(n),
      store: 'kindle',
    });
    if (n === 1) first = id;
    else second = id;
    ensureUserRow(db, id);
    db.prepare(
      `INSERT INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
      VALUES (?, 'hardcover', ?, 1, 1, ?, ?, ?)`,
    ).run(
      id,
      String(500 + n),
      JSON.stringify({ title: 1, author: 'agrees', isbn: 'none', notes: [] }),
      JSON.stringify({
        source: 'hardcover',
        sourceId: String(500 + n),
        title: `Copper Orchards Vol. ${n}`,
        authors: ['Ada Fen'],
        isbns: [],
        subjects: ['Comics'],
        series: { name: 'Copper Orchards', position: n, status: 'ongoing' },
      }),
      new Date().toISOString(),
    );
    applyIdentity(db, id);
  }
  syncSeries(db);
  seriesId = db.prepare('SELECT series_id FROM items WHERE id = ?').pluck().get(first) as string;
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: 4818,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
    fetcher: async (_url, init) => {
      const b = JSON.parse(String(init.body));
      calls.push(b.query ?? 'GET');
      if (fail) return Response.json({ errors: [{ message: 'temporarily unavailable' }] });
      if (gate) await gate;
      if (b.query.includes('SeriesMembership') && ambiguous)
        return Response.json({
          data: {
            book_series: [700, 701].map((id) => ({
              featured: false,
              compilation: false,
              position: b.variables.book === 501 ? 1 : 2,
              series: { id, name: 'Copper Orchards' },
            })),
          },
        });
      if (b.query.includes('SeriesMembership'))
        return Response.json({
          data: {
            book_series: [
              {
                featured: true,
                compilation: false,
                position: b.variables.book === 501 ? 1 : 2,
                series: { id: 700, name: 'Copper Orchards' },
              },
            ],
          },
        });
      return Response.json(catalogue());
    },
  });
});
afterEach(async () => {
  await made.close();
  db.close();
});

describe('published volumes beyond the owned library', () => {
  it('offers a catalogue-only lookup for an identified library and again after seven days', async () => {
    for (const id of [first, second]) {
      const facts = matchFactsFor(db, id)!;
      for (const source of made.sources.forItem(facts.kind, facts.issue ?? null))
        db.prepare(
          `INSERT INTO lookup_state
          (item_id, source, version, query, looked_up_at, outcome, error)
          VALUES (?, ?, ?, ?, ?, 'matched', NULL)`,
        ).run(
          id,
          source.name,
          MATCH_VERSION,
          JSON.stringify(buildQuery(facts)),
          new Date().toISOString(),
        );
    }
    made.lookups.invalidate();
    expect((await get('/api/lookups')).body).toMatchObject({ pending: 0, pendingSeries: 1 });
    await post('/api/lookups');
    await made.lookups.wait();
    expect((await get('/api/lookups')).body).toMatchObject({ pending: 0, pendingSeries: 0 });
    db.prepare('UPDATE series_publications SET checked_at = ?').run(
      new Date(Date.now() - 8 * 86_400_000).toISOString(),
    );
    made.lookups.invalidate();
    expect((await get('/api/lookups')).body).toMatchObject({ pending: 0, pendingSeries: 1 });
  });
  it('remembers a series it can’t identify instead of asking again every run, and names it', async () => {
    ambiguous = true;
    made.lookups.start({ itemIds: [] });
    const run = await made.lookups.wait();
    expect(run?.errors.join(' ')).toMatch(/“Copper Orchards”: Couldn’t confidently identify/);
    made.lookups.invalidate();
    expect((await get('/api/lookups')).body).toMatchObject({ pendingSeries: 0 });
    const asked = calls.length;
    made.lookups.start({ itemIds: [] });
    expect((await made.lookups.wait())?.errors ?? []).toEqual([]);
    expect(calls.length).toBe(asked); // nothing asked again
    // Correcting the book's number (its anchor) makes it worth checking again.
    db.prepare('UPDATE items SET series_position = 3 WHERE id = ?').run(first);
    made.lookups.invalidate();
    expect((await get('/api/lookups')).body).toMatchObject({ pendingSeries: 1 });
    // The series page's own button always asks again.
    ambiguous = false;
    db.prepare('UPDATE items SET series_position = 1 WHERE id = ?').run(first);
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM series_publication_problems').pluck().get()).toBe(0);
  });
  it('hides the saved catalogue when its anchor volume number is corrected', async () => {
    await post(`/api/series/${seriesId}/publications`);
    db.prepare('UPDATE items SET series_position = 9 WHERE id = ?').run(first);
    expect((await get(`/api/series/${seriesId}`)).body.publications).toBeNull();
  });
  it('shows missing published volumes 3–4 while the story is ongoing and recommends only owned books', async () => {
    expect((await get(`/api/series/${seriesId}`)).body.publications).toBeNull();
    const count = db.prepare('SELECT COUNT(*) FROM items').pluck().get();
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(200);
    const view = (await get(`/api/series/${seriesId}`)).body;
    expect(view.status).toBe('ongoing');
    expect(view.total).toBeNull();
    expect(view.publications.volumes).toHaveLength(4);
    expect(view.publications.missingRanges).toEqual([{ from: 3, to: 4 }]);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(count);
    const next = (await get('/api/next')).body;
    expect(JSON.stringify(next)).not.toContain('Copper Orchards Vol. 3');
    expect(JSON.stringify(next)).not.toContain('Copper Orchards Vol. 4');
  });

  it('updates missing volumes after an ownership or read-elsewhere change, without new requests', async () => {
    await post(`/api/series/${seriesId}/publications`);
    createStoreItem(db, {
      title: 'Copper Orchards Vol. 3',
      kind: 'comic',
      series: 'Copper Orchards',
      number: '3',
      store: 'kindle',
    });
    syncSeries(db);
    await post(`/api/series/${seriesId}/read-elsewhere`, { unit: 'volume', from: 4 });
    expect((await get(`/api/series/${seriesId}`)).body.publications.missing).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it('keeps a last successful catalogue when a later request fails', async () => {
    await post(`/api/series/${seriesId}/publications`);
    const before = (await get(`/api/series/${seriesId}`)).body.publications;
    fail = true;
    expect((await post(`/api/series/${seriesId}/publications`)).status).not.toBe(200);
    expect((await get(`/api/series/${seriesId}`)).body.publications).toEqual(before);
  });

  it('requires trusted identity and does not keep using a catalogue anchored to a rejected match', async () => {
    await post(`/api/series/${seriesId}/publications`);
    db.prepare("UPDATE user_item SET match_override = 'none' WHERE item_id IN (?, ?)").run(
      first,
      second,
    );
    expect((await get(`/api/series/${seriesId}`)).body.publications).toBeNull();
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(409);
    expect(calls).toHaveLength(2);
  });

  it('explains unknown coverage with no token and never asks for a file scan', async () => {
    setSecret(db, 'hardcover_token', null);
    const view = (await get(`/api/series/${seriesId}`)).body;
    expect(view.publicationLookup).toMatchObject({
      available: false,
      reason: expect.stringContaining('Hardcover token'),
    });
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('deduplicates catalogue checks by series and reuses a fresh catalogue', async () => {
    expect(publicationSeries(db, made.sources)).toEqual([seriesId]);
    expect(await refreshPublications(db, made.sources, seriesId)).toBe(true);
    expect(await refreshPublications(db, made.sources, seriesId)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('does not promote a provisional catalogue anchor unless the owner confirms it', async () => {
    db.prepare('UPDATE item_matches SET score = 0.85').run();
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(409);
    db.prepare("UPDATE user_item SET match_override = 'hardcover:501' WHERE item_id = ?").run(
      first,
    );
    expect((await post(`/api/series/${seriesId}/publications`)).status).toBe(200);
  });

  it('keeps the lookup run active through catalogue checks and honours cancellation', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    made.lookups.start({ itemIds: [] });
    try {
      await expect.poll(() => made.lookups.status()?.series).toEqual({ done: 0, total: 1 });
      expect(made.lookups.isRunning()).toBe(true);
      expect(() => made.lookups.start()).toThrow(/already running/);
      expect(made.lookups.requestCancel()).toBe(true);
    } finally {
      release();
    }
    expect((await made.lookups.wait())?.status).toBe('cancelled');
    expect(made.lookups.isRunning()).toBe(false);
  });

  it('preserves published catalogues through backup and restore with no connected folders', async () => {
    await post(`/api/series/${seriesId}/publications`);
    const backup = createBackup(db);
    expect(backup.tables.series_publications).toHaveLength(1);
    const empty = await memoryDb();
    try {
      await restoreBackup(empty, backup, null);
      expect(createBackup(empty).tables.series_publications).toEqual(
        backup.tables.series_publications,
      );
      const old = structuredClone(backup);
      old.schemaVersion = 8;
      delete old.tables.series_publications;
      await restoreBackup(empty, validateBackup(empty, old), null);
      expect(empty.prepare('SELECT COUNT(*) FROM series_publications').pluck().get()).toBe(0);
    } finally {
      empty.close();
    }
  });

  it('refuses to attach results after the owner changes identity during the request', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = refreshPublications(db, made.sources, seriesId, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.prepare("UPDATE user_item SET match_override = 'none' WHERE item_id IN (?, ?)").run(
      first,
      second,
    );
    release();
    await expect(running).rejects.toMatchObject({ status: 409 });
    expect(db.prepare('SELECT COUNT(*) FROM series_publications').pluck().get()).toBe(0);
  });
});
