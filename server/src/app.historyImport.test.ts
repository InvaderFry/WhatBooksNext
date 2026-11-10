import fs from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { createBackup, restoreBackup } from './lib/backup.ts';
import { historyDate } from './lib/historyImport.ts';
import { memoryDb, fakePlatformWithDrives } from './testing/helpers.ts';

let db: DB;
let made: ReturnType<typeof createApp>;
const fixture = (s: string) =>
  fs.readFileSync(new URL(`../../fixtures/imports/${s}.csv`, import.meta.url), 'utf8');
const post = (url: string, body: object) =>
  request(made.app).post(url).set('Host', 'localhost:4818').send(body);
const get = (url: string) => request(made.app).get(url).set('Host', 'localhost:4818');
const upload = (source = 'goodreads', extra = {}) =>
  post('/api/import/history', { source, text: fixture(source), ...extra });
const user = (title: string) =>
  db
    .prepare('SELECT u.* FROM user_item u JOIN items i ON i.id = u.item_id WHERE i.title = ?')
    .get(title) as Record<string, unknown>;
const owned = async (title = 'The Copper Orchard', isbn = '9780000000017') =>
  (await post('/api/store/items', { title, author: 'Wenna Vale', isbn, store: 'kindle' })).body
    .itemId as string;

beforeEach(async () => {
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({}),
    port: 4818,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
  });
});
afterEach(async () => {
  await made.close();
});

describe('Goodreads and StoryGraph history imports', () => {
  it('previews a real export layout with invented books without changing the library', async () => {
    const id = await owned();
    const p = await post('/api/import/history/preview', {
      source: 'goodreads',
      text: fixture('goodreads'),
    });
    expect(p.status).toBe(200);
    expect(p.body.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      'isbn',
      'history',
      'skip',
      'history',
    ]);
    expect(p.body.rows[0]).toMatchObject({
      itemId: id,
      applies: ['progress finished', 'finished 2024-05-17 (exact)', 'rating 8/10', 'note'],
    });
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM import_keys').pluck().get()).toBe(0);
  });

  it.each(['goodreads', 'storygraph'])(
    'imports %s history without treating wishlists or history as owned',
    async (source) => {
      const r = await upload(source);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ added: 3, attached: 0, already: 0, skipped: 1 });
      expect(user('The Copper Orchard')).toMatchObject({
        progress: 'finished',
        finished_on: '2024-05-17',
        finished_precision: 'exact',
        rating: source === 'goodreads' ? 8 : 7,
      });
      expect(user('Paper Weather')).toMatchObject({
        finished_on: null,
        finished_precision: 'unknown',
        rating: null,
      });
      expect(user('The Lantern Ledger')).toMatchObject({
        progress: source === 'goodreads' ? 'into_it' : 'dnf',
        started_on: null,
        started_precision: 'unknown',
        dnf_reason: null,
      });
      expect(db.prepare("SELECT COUNT(*) FROM locations WHERE kind = 'store'").pluck().get()).toBe(
        0,
      );
      expect(
        db.prepare("SELECT COUNT(*) FROM items WHERE title = 'A Map of Ash'").pluck().get(),
      ).toBe(0);
      const response = await get('/api/next');
      expect(response.status).toBe(200);
      const picks = response.body;
      expect(JSON.stringify(picks)).not.toContain('The Lantern Ledger');
      expect(
        db.prepare("SELECT identifiers FROM items WHERE title = 'Paper Weather'").pluck().get(),
      ).toBe('{}');
    },
  );

  it('attaches corroborated ISBN matches to owned books and requires confirmation for title matches', async () => {
    const isbn = await owned();
    const title = await owned('Paper Weather', '9780000000031');
    const p = (
      await post('/api/import/history/preview', { source: 'goodreads', text: fixture('goodreads') })
    ).body;
    // A different named author is not silently treated as this book.
    expect(p.rows[1].outcome).toBe('history');
    db.prepare('UPDATE items SET creators = ? WHERE id = ?').run(
      JSON.stringify([{ name: 'Pim Arkwright' }]),
      title,
    );
    const p2 = (
      await post('/api/import/history/preview', { source: 'goodreads', text: fixture('goodreads') })
    ).body;
    expect(p2.rows[1]).toMatchObject({ outcome: 'possible', itemId: title });
    expect((await upload('goodreads', { attach: [3] })).body).toEqual({
      added: 1,
      attached: 2,
      already: 0,
      skipped: 1,
    });
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(isbn)).toBe(
      'finished',
    );
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(title)).toBe(
      'finished',
    );
  });

  it('keeps each StoryGraph author separate and corroborates an ISBN with any of them', async () => {
    const id = await owned('A Different Subtitle');
    db.prepare('UPDATE items SET creators = ? WHERE id = ?').run(
      JSON.stringify([{ name: 'Pim Arkwright' }]),
      id,
    );
    const text =
      'Title,Authors,ISBN/UID,Read Status\nAlternate Title,"Ada Fen, Pim Arkwright",9780000000017,read\nShared Almanac,"Ada Fen, Pim Arkwright",,read';
    const p = (await post('/api/import/history/preview', { source: 'storygraph', text })).body;
    expect(p.rows[0]).toMatchObject({ outcome: 'isbn', itemId: id });
    await post('/api/import/history', { source: 'storygraph', text });
    expect(
      JSON.parse(
        db
          .prepare("SELECT creators FROM items WHERE title = 'Shared Almanac'")
          .pluck()
          .get() as string,
      ),
    ).toEqual([{ name: 'Ada Fen' }, { name: 'Pim Arkwright' }]);
  });

  it('never transfers history on an ISBN whose title and author both disagree', async () => {
    const id = await owned('An Entirely Different Work');
    db.prepare("UPDATE items SET creators = '[]' WHERE id = ?").run(id);
    const p = (
      await post('/api/import/history/preview', { source: 'goodreads', text: fixture('goodreads') })
    ).body;
    expect(p.rows[0].outcome).toBe('history');
    await upload();
    expect(db.prepare('SELECT progress FROM user_item WHERE item_id = ?').pluck().get(id)).not.toBe(
      'finished',
    );
  });

  it('keeps existing edits and preserves even cleared data on a repeat import', async () => {
    const id = await owned();
    await request(made.app)
      .patch(`/api/items/${id}`)
      .set('Host', 'localhost:4818')
      .send({ progress: 'halfway', rating: 2, note: 'My own note' });
    const p = (
      await post('/api/import/history/preview', { source: 'goodreads', text: fixture('goodreads') })
    ).body;
    expect(p.rows[0].kept).toHaveLength(3);
    await upload();
    expect(user('The Copper Orchard')).toMatchObject({
      progress: 'halfway',
      rating: 2,
      note: 'My own note',
    });
    await request(made.app)
      .patch(`/api/items/${id}`)
      .set('Host', 'localhost:4818')
      .send({ progress: 'not_started', rating: null, note: null });
    const before = createBackup(db).tables;
    expect((await upload()).body).toEqual({ added: 0, attached: 0, already: 3, skipped: 1 });
    expect(createBackup(db).tables).toEqual(before);
  });

  it('keeps an explicit reset to not started even on the first history import', async () => {
    const id = await owned();
    for (const progress of ['halfway', 'not_started'])
      await request(made.app)
        .patch(`/api/items/${id}`)
        .set('Host', 'localhost:4818')
        .send({ progress });
    await upload();
    expect(user('The Copper Orchard')).toMatchObject({
      progress: 'not_started',
      finished_on: null,
    });
  });

  it('skips possible matches unless confirmed instead of creating another copy', async () => {
    const id = await owned('Paper Weather', '9780000000031');
    db.prepare('UPDATE items SET creators = ? WHERE id = ?').run(
      JSON.stringify([{ name: 'Pim Arkwright' }]),
      id,
    );
    expect((await upload()).body).toEqual({ added: 2, attached: 0, already: 0, skipped: 2 });
    expect(
      db.prepare("SELECT COUNT(*) FROM items WHERE title = 'Paper Weather'").pluck().get(),
    ).toBe(1);
  });

  it('skips unmatched records when asked and does not record them as imported', async () => {
    await owned();
    expect((await upload('storygraph', { keepUnmatched: false })).body).toEqual({
      added: 0,
      attached: 1,
      already: 0,
      skipped: 3,
    });
    expect(db.prepare('SELECT COUNT(*) FROM import_keys').pluck().get()).toBe(1);
  });

  it.each(['did-not-finish', 'currently-reading'])(
    'never fills a series gap with unfinished unowned history (%s)',
    async (status) => {
      for (const number of ['1', '3'])
        await post('/api/store/items', {
          title: `Clockwater ${number}`,
          kind: 'fiction',
          series: 'Clockwater',
          number,
          store: 'kindle',
        });
      await post('/api/import/history', {
        source: 'storygraph',
        text: `Title,Authors,Read Status\nClockwater Two,Ada Fen,${status}`,
      });
      const id = db
        .prepare("SELECT id FROM items WHERE title = 'Clockwater Two'")
        .pluck()
        .get() as string;
      await request(made.app)
        .patch(`/api/items/${id}`)
        .set('Host', 'localhost:4818')
        .send({ kindOverride: 'fiction', seriesOverride: 'Clockwater', seriesPositionOverride: 2 });
      const detail = (await get(`/api/items/${id}`)).body;
      const { seriesView } = await import('./lib/seriesView.ts');
      const view = seriesView(db, new Map(), detail.series.id);
      expect(view.entries.find((e) => e.id === id)).toMatchObject({
        holding: null,
        availabilityLabel: 'History only · not owned',
      });
      expect(view.gaps).toHaveLength(1);
      const picks = (await get('/api/next')).body;
      expect(JSON.stringify(picks)).not.toContain('Clockwater Two');
      expect(JSON.stringify(picks)).toMatch(/volume 2/);
      const filled = await post(`/api/series/${detail.series.id}/read-elsewhere`, {
        unit: 'volume',
        from: 2,
        to: 2,
      });
      expect(filled.body.itemIds).toHaveLength(1);
      expect((await get(`/api/items/${id}`)).body.user.progress).toBe(
        status === 'did-not-finish' ? 'dnf' : 'into_it',
      );
      expect(seriesView(db, new Map(), detail.series.id).gaps).toHaveLength(0);
      await request(made.app)
        .delete(`/api/items/${filled.body.itemIds[0]}`)
        .set('Host', 'localhost:4818')
        .send({});
      expect(seriesView(db, new Map(), detail.series.id).gaps).toHaveLength(1);
      await request(made.app)
        .patch(`/api/items/${id}`)
        .set('Host', 'localhost:4818')
        .send({ progress: 'finished', finishedPrecision: 'unknown' });
      expect(seriesView(db, new Map(), detail.series.id).gaps).toHaveLength(0);
    },
  );

  it('preserves history, dates and repeatability through backup and restore with no folders', async () => {
    await upload();
    const backup = createBackup(db);
    const restored = await memoryDb();
    try {
      await restoreBackup(restored, backup, null);
      expect(createBackup(restored).tables).toEqual(backup.tables);
      const { importHistory } = await import('./lib/historyImport.ts');
      expect(
        importHistory(restored, fixture('goodreads'), 'goodreads', {
          attach: [],
          keepUnmatched: true,
        }).already,
      ).toBe(3);
    } finally {
      restored.close();
    }
  });

  it('reports rating conversion, invalid dates and rereads before importing', async () => {
    const p = (
      await post('/api/import/history/preview', {
        source: 'storygraph',
        text: fixture('storygraph'),
      })
    ).body;
    expect(p.problems.join(' ')).toMatch(/3.25\/5 becomes 6.5\/10, rounded to 7\/10/);
    expect(p.problems.join(' ')).toMatch(/rereads/);
    const text =
      'Title,Author,Exclusive Shelf,My Rating,Date Read\nOdd Weather,Ada Fen,read,8,2023/02/29';
    const invalid = (await post('/api/import/history/preview', { source: 'goodreads', text })).body;
    expect(invalid.problems.join(' ')).toMatch(/rating.*left out.*date.*unknown/);
    await post('/api/import/history', { source: 'goodreads', text });
    expect(user('Odd Weather')).toMatchObject({
      rating: null,
      finished_on: null,
      finished_precision: 'unknown',
    });
  });

  it('keeps approximate dates and never substitutes the upload date', async () => {
    const text =
      'Title,Author,Exclusive Shelf,Date Read\nYear Only,Ada Fen,read,2020\nMonth Only,Ada Fen,read,2021/06\nNo Date,Ada Fen,read,';
    await post('/api/import/history', { source: 'goodreads', text });
    expect(user('Year Only')).toMatchObject({
      finished_on: '2020',
      finished_precision: 'approximate',
    });
    expect(user('Month Only')).toMatchObject({
      finished_on: '2021-06',
      finished_precision: 'approximate',
    });
    expect(user('No Date')).toMatchObject({ finished_on: null, finished_precision: 'unknown' });
    expect(historyDate('2024/02/29', 'goodreads').value).toBe('2024-02-29');
    expect(historyDate('2023/02/29', 'goodreads').value).toBeNull();
  });

  it('refuses the wrong source, malformed CSV and duplicate headers without writing anything', async () => {
    for (const body of [
      { source: 'other', text: fixture('goodreads') },
      { source: 'goodreads', text: fixture('storygraph') },
      { source: 'goodreads', text: 'Title,Author,Exclusive Shelf\n"unfinished' },
      { source: 'goodreads', text: 'Title,Author,Exclusive Shelf,Title\nA,B,read,C' },
    ])
      expect((await post('/api/import/history', body)).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(0);
  });

  it('ignores duplicate rows, accepts an Excel BOM and keeps multiline review text', async () => {
    const text =
      '\uFEFFTitle,Author,Exclusive Shelf,My Review\r\nRain Ledger,Ada Fen,read,"First line, with comma\nSecond line"\r\nRain Ledger,Ada Fen,read,same book';
    const p = (await post('/api/import/history/preview', { source: 'goodreads', text })).body;
    expect(p.rows).toHaveLength(1);
    expect(p.problems.join(' ')).toMatch(/earlier row/);
    expect((await post('/api/import/history', { source: 'goodreads', text })).body.added).toBe(1);
    expect(user('Rain Ledger').note).toBe('First line, with comma\nSecond line');
  });
});
