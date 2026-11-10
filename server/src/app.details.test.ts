import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { matchFactsFor } from './identify/lookups.ts';
import { loadLibrary } from './lib/library.ts';
import { loadRankData } from './lib/rankData.ts';
import { applyUserPatch } from './lib/progress.ts';
import { buildDetailCases } from './testing/detailCases.ts';
import { fakePlatformWithDrives, memoryDb } from './testing/helpers.ts';
import { compareDetails } from '../../scripts/detailComparison.ts';
import { topicsOf } from './lib/recommend.ts';

let db: DB;
let app: ReturnType<typeof createApp>;
let ids: Record<string, string>;
let calls: number;
const get = (url: string) => request(app.app).get(url).set('Host', 'localhost:4818');
beforeEach(async () => {
  db = await memoryDb();
  ids = buildDetailCases(db);
  calls = 0;
  app = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: 4818,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
    fetcher: async () => {
      calls++;
      throw new Error('No network in detail tests');
    },
  });
});
afterEach(async () => {
  expect(calls).toBe(0);
  await app.close();
});

describe('Stage 2 detail integration', () => {
  it('uses Calibre and trusted creators across Library, item pages, cards, triage and CSV', async () => {
    const id = ids.calibre!;
    const item = (await get(`/api/items/${id}`)).body;
    expect(item).toMatchObject({
      title: 'Calibre Copper Observatory',
      factTitle: 'Embedded Copper Observatory',
      creators: [{ name: 'Curated Writer' }],
    });
    expect(item.details.title).toMatchObject({ source: 'calibre', reason: 'calibre_title' });
    for (const url of ['/api/next', '/api/triage']) {
      const r = (await get(url)).body;
      const cards = r.cards ?? r.items;
      const c = cards.find((i: { id: string }) => i.id === id);
      expect(c).toMatchObject({ title: item.title, creators: item.creators });
    }
    const csv = (await get('/api/export/csv')).text;
    expect(csv).toContain('Calibre Copper Observatory,Curated Writer');
  });

  it('searches both the displayed source title and the original file title', async () => {
    for (const q of ['Calibre Copper Observatory', 'Embedded Copper Observatory']) {
      const r = await get(`/api/items?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(r.body.items.map((i: { id: string }) => i.id)).toContain(ids.calibre);
    }
  });

  it('never displays facts from provisional, tied or rejected matches', async () => {
    for (const name of ['provisional', 'tie', 'rejected']) {
      const data = (await get(`/api/items/${ids[name]}/online`)).body;
      expect(data).toMatchObject({ firstPublishYear: null, description: null, subjects: [] });
      expect(data.details.pages).toBeNull();
      expect(data.details.creators).toBeNull();
      expect(data.details.title.source).toBe('filename');
    }
    expect(
      (await get(`/api/items/${ids.provisional}/online`)).body.details.suggestions,
    ).toHaveLength(1);
  });

  it('keeps reading data and every matching input unchanged across all detail-consuming reads', async () => {
    applyUserPatch(db, ids.owner!, {
      rating: 9,
      progress: 'halfway',
      note: 'Private invented note',
    });
    const before = db.prepare('SELECT * FROM items ORDER BY id').all();
    const users = db.prepare('SELECT * FROM user_item ORDER BY item_id').all();
    const matches = db.prepare('SELECT * FROM item_matches ORDER BY item_id,source,rank').all();
    const inputs = Object.values(ids).map((id) => matchFactsFor(db, id));
    for (const url of [
      '/api/items',
      '/api/next',
      '/api/triage',
      '/api/export/csv',
      '/api/stats',
      '/api/diagnostics',
      `/api/items/${ids.owner}`,
      `/api/items/${ids.owner}/online`,
    ]) {
      expect((await get(url)).status).toBe(200);
    }
    expect(db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM user_item ORDER BY item_id').all()).toEqual(users);
    expect(db.prepare('SELECT * FROM item_matches ORDER BY item_id,source,rank').all()).toEqual(
      matches,
    );
    expect(Object.values(ids).map((id) => matchFactsFor(db, id))).toEqual(inputs);
  });

  it('labels measured and source pages, prefers the file ISBN, and keeps issue years apart from series starts', async () => {
    const pages = (await get(`/api/items/${ids.pages}/online`)).body;
    expect(pages.details.pages).toMatchObject({
      value: 240,
      source: 'openlibrary',
      measured: false,
      reason: 'file_isbn',
    });
    expect(pages.duration.basis).toContain('240 pages (Open Library)');
    expect((await get(`/api/items/${ids.measured}/online`)).body.details.pages).toMatchObject({
      value: 120,
      source: 'file',
      measured: true,
    });
    expect((await get(`/api/items/${ids.issue}/online`)).body.firstPublishYear).toBe(2019);
    const years = (await get(`/api/items/${ids.year}/online`)).body;
    expect(years.firstPublishYear).toBe(1990);
    expect(years.details.yearDisagreement).toBe(true);
    expect(years.details.years.map((y: { value: number }) => y.value)).toEqual([1990, 2005]);
  });

  it('keeps kind, topic and taste inputs even when display creators and provisional subjects differ', () => {
    const library = loadLibrary(db, new Map());
    const data = loadRankData(db, new Map());
    const i = data.items.find((i) => i.id === ids.provisional)!;
    expect(i.subjects).toContain('Provisional topic');
    expect(topicsOf(i, ['Provisional topic'])).toEqual(['Provisional topic']);
    expect(data.details.get(i.id)?.subjects).toEqual([]);
    for (const i of data.items) {
      expect(i.title).toBe(library.rankingFacts.get(i.id)?.title);
      expect(i.creators).toEqual(library.rankingFacts.get(i.id)?.creators);
      expect(i.kind).toBe(library.items.find((l) => l.id === i.id)?.kind);
    }
    expect(compareDetails(db)).toMatchObject({
      kindChanged: 0,
      tasteTopicsChanged: 0,
      tasteChanged: false,
      matchingInputsChanged: 0,
    });
  });

  it('compares only invented stored details and reports changed fields and Classics without titles', () => {
    const r = compareDetails(db);
    expect(r).toMatchObject({
      items: 14,
      changed: { title: 2, authors: 8, year: 2, pages: 2, description: 5 },
      classics: { before: 3, after: 2, entering: 0, leaving: 1 },
    });
    expect(JSON.stringify(r)).not.toContain('Copper Observatory');
  });
});
