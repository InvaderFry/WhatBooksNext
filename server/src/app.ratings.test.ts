import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { applyIdentity, storeCandidates } from './identify/lookups.ts';
import type { ScoredCandidate } from './identify/match.ts';
import { buildDemoLibrary } from './lib/demo.ts';
import { loadRankData } from './lib/rankData.ts';
import { runMode } from './lib/modes.ts';
import { createStoreItem, parseCsv } from './lib/store.ts';
import { applyUserPatch } from './lib/progress.ts';
import { fakePlatformWithDrives, memoryDb, tempDir } from './testing/helpers.ts';
import { page, situation } from './testing/rank.ts';
import { rating } from './testing/ratings.ts';
import type { RatedFrom } from './lib/ratings.ts';
import { compareRatings } from './lib/ratingComparison.ts';
import { ratingCases } from './testing/ratingCases.ts';

let db: DB;
let made: ReturnType<typeof createApp>;
let networkCalls: number;
const get = (url: string) => request(made.app).get(url).set('Host', 'localhost:4818');
const post = (url: string, body: object) =>
  request(made.app).post(url).set('Host', 'localhost:4818').send(body);

beforeEach(async () => {
  db = await memoryDb();
  networkCalls = 0;
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: 4818,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
    fetcher: async () => {
      networkCalls++;
      throw new Error('No network in rating tests');
    },
  });
});
afterEach(async () => {
  expect(networkCalls).toBe(0);
  await made.close();
});

const book = () =>
  createStoreItem(db, {
    title: 'An Invented Observatory',
    author: 'Invented Writer',
    kind: 'fiction',
    store: 'kindle',
  });
function save(id: string, rs: RatedFrom[]) {
  for (const source of new Set(rs.map((r) => r.source))) {
    const candidates: ScoredCandidate[] = rs
      .filter((r) => r.source === source)
      .map((r) => ({
        score: r.matchScore,
        evidence: { title: 1, author: 'agrees', isbn: r.strongIsbn ? 'strong' : 'none', notes: [] },
        record: {
          source,
          sourceId: r.sourceId,
          title: 'An Invented Observatory',
          authors: [
            r.sourceId === 'tie-a'
              ? 'Cora Pell'
              : r.sourceId === 'tie-b'
                ? 'Nima Ocho'
                : 'Invented Writer',
          ],
          isbns: [],
          subjects: [],
          firstPublishYear: 1980,
          rating: { value: r.value, scale: r.scale, scope: r.scope, count: r.count },
          url: 'https://example.invalid/invented',
        },
      }));
    storeCandidates(db, id, source, candidates);
  }
  applyIdentity(db, id);
}

describe('Stage 1 rating integration', () => {
  it('uses the same selection in detail, ranking, highly-rated modes and appended export columns without rewriting matches', async () => {
    const id = book();
    save(id, [rating({ count: 25 }), rating({ source: 'openlibrary', count: 5000 })]);
    const before = db.prepare('SELECT * FROM item_matches').all();
    const detail = (await get(`/api/items/${id}/online`)).body;
    expect(detail.community).toMatchObject({
      source: 'openlibrary',
      votes: 5000,
      match: 'accepted',
      tier: 1,
    });
    for (const mode of ['read_next', 'waiting', 'classics']) {
      const r = await get(`/api/next?view=${mode}`);
      expect(r.status).toBe(200);
      expect(r.body.cards.map((c: { id: string }) => c.id)).toContain(id);
    }
    const csv = parseCsv((await get('/api/export/csv')).text);
    const header = csv[1]!;
    expect(header.slice(-3)).toEqual(['id', 'community_scope', 'community_match']);
    const row = csv.find((r) => r[header.indexOf('id')] === id)!;
    expect(row[header.indexOf('community_source')]).toBe('Open Library');
    expect(row.slice(-2)).toEqual(['book', 'accepted']);
    expect(db.prepare('SELECT * FROM item_matches').all()).toEqual(before);
  });

  it('orders triage by the selected community score while Library sorting stays personal-only', async () => {
    const a = book(),
      b = book();
    save(a, [
      rating({ sourceId: 'a-hc', value: 1, count: 25 }),
      rating({ source: 'openlibrary', sourceId: 'a-ol', value: 5, count: 5000 }),
    ]);
    save(b, [
      rating({ sourceId: 'b-hc', value: 4.2, count: 25 }),
      rating({ source: 'openlibrary', sourceId: 'b-ol', value: 1, count: 3 }),
    ]);
    applyUserPatch(db, a, { rating: 1 });
    applyUserPatch(db, b, { rating: 10 });
    expect((await get('/api/triage')).body.items.map((i: { id: string }) => i.id)).toEqual([a, b]);
    expect(
      (await get('/api/items?sort=rating&dir=desc')).body.items.map((i: { id: string }) => i.id),
    ).toEqual([b, a]);
  });

  it('sorts the Library by the online rating, adjusted for votes, with unrated books last either way', async () => {
    const popular = book(),
      few = book(),
      none = book();
    save(popular, [rating({ sourceId: 'p-ol', source: 'openlibrary', value: 4.3, count: 5000 })]);
    save(few, [rating({ sourceId: 'f-ol', source: 'openlibrary', value: 5, count: 2 })]);
    // Enough other Open Library books that shrinkage has a mean and median to pull toward.
    for (let n = 0; n < 6; n++)
      save(book(), [rating({ sourceId: `o-${n}`, source: 'openlibrary', value: 3, count: 200 })]);
    const order = async (dir: string) =>
      (await get(`/api/items?sort=community&dir=${dir}`)).body.items.map(
        (i: { id: string }) => i.id,
      );
    const desc = await order('desc');
    expect(desc.indexOf(popular)).toBeLessThan(desc.indexOf(few));
    expect(desc.at(-1)).toBe(none);
    expect((await order('asc')).at(-1)).toBe(none);
    const row = (await get('/api/items?sort=community&dir=desc')).body.items.find(
      (i: { id: string }) => i.id === popular,
    );
    expect(row.community).toMatchObject({
      raw: 4.3,
      scale: 5,
      votes: 5000,
      sourceLabel: 'Open Library',
      unconfirmed: false,
    });
    expect(
      (await get('/api/items')).body.items.find((i: { id: string }) => i.id === none).community,
    ).toBeNull();
  });

  it('keeps confirmation and ISBN evidence local to their own source and excludes tied, rejected and wrong-volume ratings', async () => {
    const id = book();
    save(id, [
      rating({ sourceId: 'hc', count: 25, strongIsbn: true }),
      rating({ source: 'openlibrary', sourceId: 'ol', count: 25, matchScore: 0.75 }),
    ]);
    expect(
      (
        await post(`/api/items/${id}/match`, {
          action: 'confirm',
          source: 'hardcover',
          sourceId: 'hc',
        })
      ).status,
    ).toBe(200);
    let data = loadRankData(db, new Map());
    expect(data.ratings.get(id)?.others[0]).toMatchObject({
      source: 'openlibrary',
      match: 'provisional',
      strongIsbn: false,
    });
    save(id, [
      rating({ sourceId: 'hc', count: 25 }),
      rating({ source: 'openlibrary', sourceId: 'ol', count: 5000 }),
    ]);
    expect(loadRankData(db, new Map()).items[0]?.community).toMatchObject({
      source: 'openlibrary',
      match: 'accepted',
    });
    for (const candidates of [
      [
        rating({ source: 'openlibrary', sourceId: 'tie-a', count: 1_000_000 }),
        rating({ source: 'openlibrary', sourceId: 'tie-b', count: 1_000_000, matchScore: 0.94 }),
      ],
      [
        rating({
          source: 'openlibrary',
          sourceId: 'wrong-volume',
          count: 1_000_000,
          matchScore: 0.3,
        }),
      ],
    ]) {
      save(id, candidates);
      data = loadRankData(db, new Map());
      expect(data.items[0]?.community?.source).toBe('hardcover');
      expect(data.ratings.get(id)?.excluded).toHaveLength(candidates.length);
    }
    save(id, [rating({ source: 'openlibrary', sourceId: 'rejected', count: 1_000_000 })]);
    expect(
      (
        await post(`/api/items/${id}/match`, {
          action: 'reject',
          source: 'openlibrary',
          sourceId: 'rejected',
        })
      ).status,
    ).toBe(200);
    expect(loadRankData(db, new Map()).items[0]?.community?.source).toBe('hardcover');
    expect((await post(`/api/items/${id}/match`, { action: 'none' })).status).toBe(200);
    expect((await get(`/api/items/${id}/online`)).body.community).toBeNull();
  });

  it('reports each tier and counts provisional default picks without exposing titles', async () => {
    const rs = [
      rating(),
      rating({ scope: 'series' }),
      rating({ count: null }),
      rating({ count: 0, scope: 'series' }),
      rating({ matchScore: 0.75, count: 8 }),
    ];
    for (const r of rs) {
      const id = book();
      save(id, [{ ...r, sourceId: `invented-${id}` }]);
      if (r.scope === 'series') {
        db.prepare(
          "INSERT INTO series (id,name,kind,updated_at) VALUES (?, ?, 'fiction', '2026-11-10')",
        ).run(`series-${id}`, `Invented Series ${id}`);
        db.prepare(
          "UPDATE items SET series_id = ?, series_position = 1, series_unit = 'volume' WHERE id = ?",
        ).run(`series-${id}`, id);
      }
    }
    book();
    const d = (await get('/api/diagnostics')).body;
    expect(d.ratings).toEqual({
      tiers: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
      unknown: 1,
      whatNext: { total: 6, provisional: 1 },
    });
    expect(JSON.stringify(d.ratings)).not.toContain('Observatory');
    const picks = (await get('/api/next')).body.cards;
    expect(picks).toHaveLength(d.ratings.whatNext.total);
    expect(
      picks.filter((c: { limitations: string[] }) =>
        c.limitations.includes('rating is from an unconfirmed match'),
      ),
    ).toHaveLength(d.ratings.whatNext.provisional);
  });

  it('compares the old and new rating choice on the stored library, with counts and no titles', async () => {
    const id = book();
    save(id, [rating({ count: 3 }), rating({ source: 'openlibrary', count: 3000 })]);
    book();
    const before = db.prepare('SELECT * FROM item_matches').all();
    const r = (await post('/api/diagnostics/rating-changes', {})).body;
    expect(r).toMatchObject({ items: 2, changedSource: 1, gained: 0, lost: 0 });
    expect(r.modes.map((m: { mode: string }) => m.mode)).toEqual([
      'hidden_gems',
      'classics',
      'waiting',
    ]);
    expect(JSON.stringify(r)).not.toContain('Observatory');
    expect(db.prepare('SELECT * FROM item_matches').all()).toEqual(before);
  });

  it('keeps populated and empty Hidden gems cases in the generated demo', async () => {
    const root = tempDir('wbn-ratings-demo-');
    try {
      const platform = await buildDemoLibrary(db, root);
      const reach = new Map(
        (db.prepare('SELECT id FROM folders').pluck().all() as string[]).map((id) => [id, true]),
      );
      const items = loadRankData(db, reach).items;
      expect(platform).toBeDefined();
      expect(runMode('hidden_gems', items, situation(), page).cards.length).toBeGreaterThan(0);
      for (const i of items) applyUserPatch(db, i.id, { triage: 'never' });
      expect(
        runMode('hidden_gems', loadRankData(db, reach).items, situation(), page),
      ).toMatchObject({ cards: [], empty: expect.any(String) });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('makes the title-free comparison reproducible over invented fixtures', () => {
    const report = compareRatings(ratingCases(), situation());
    expect(report).toMatchObject({
      items: 59,
      changedSource: 38,
      gained: 0,
      lost: 0,
      movedTier: 5,
    });
    expect(report.sourceTargets.find((s) => s.source === 'anilist')).toMatchObject({
      before: 13,
      after: 2,
    });
    expect(report.modes.find((m) => m.mode === 'hidden_gems')).toMatchObject({
      before: 1,
      after: 0,
      leaving: 1,
    });
    expect(JSON.stringify(report)).not.toContain('Invented Rating Case');
  });
});
