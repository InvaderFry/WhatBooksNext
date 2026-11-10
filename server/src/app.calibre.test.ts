import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { DB } from './db/database.ts';
import { makeCalibreDb } from './testing/calibre.ts';
import { makeEpub } from './testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from './testing/helpers.ts';

/** Calibre import (M4: PLAN.md §14), against an invented Calibre library. */

const PORT = 4818;
const HOST = `localhost:${PORT}`;

let db: DB;
let drive: string;
let made: ReturnType<typeof createApp>;
let library: string;

const api = {
  get: (url: string) => request(made.app).get(url).set('Host', HOST),
  post: (url: string, body: object = {}) =>
    request(made.app).post(url).set('Host', HOST).send(body),
  patch: (url: string, body: object) => request(made.app).patch(url).set('Host', HOST).send(body),
};

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

beforeEach(async () => {
  drive = tempDir('wbn-m4-calibre-');
  library = path.join(drive, 'Calibre Library');
  writeFiles(drive, {
    // A book in the Calibre library, inside the scanned drive.
    'Calibre Library/Juno Tarrant/The Quiet Cartographer (1)/The Quiet Cartographer - Juno Tarrant.epub':
      makeEpub({
        title: 'The Quiet Cartographer',
        creators: ['Juno Tarrant'],
        chapters: [900],
        seed: 1,
      }),
    // The same book as a Calibre entry whose file lives elsewhere, matched by ISBN.
    'Other/salt-and-signal.epub': makeEpub({
      title: 'Salt and Signal',
      creators: ['Mabry Quell'],
      identifiers: ['9780000000024'],
      chapters: [900],
      seed: 2,
    }),
  });
  makeCalibreDb(library, [
    {
      title: 'The Quiet Cartographer',
      authors: ['Juno Tarrant'],
      path: 'Juno Tarrant/The Quiet Cartographer (1)',
      formats: [{ format: 'EPUB', name: 'The Quiet Cartographer - Juno Tarrant' }],
      series: 'Lanterns of Ost',
      seriesIndex: 2,
      tags: ['Fantasy'],
      rating: 8,
      read: true,
      readOn: '2024-05-17',
    },
    {
      title: 'Salt and Signal',
      authors: ['Mabry Quell'],
      path: 'Mabry Quell/Salt and Signal (2)',
      formats: [{ format: 'EPUB', name: 'Salt and Signal - Mabry Quell' }],
      isbn: '978-0-00-000002-4',
      rating: 0,
      read: false,
    },
    {
      title: 'A Lexicon of Lost Weather',
      authors: ['Ines Varro'],
      path: 'Ines Varro/A Lexicon of Lost Weather (3)',
      formats: [{ format: 'PDF', name: 'A Lexicon of Lost Weather - Ines Varro' }],
      read: true,
    },
  ]);
  db = await memoryDb();
  made = createApp({
    db,
    platform: fakePlatformWithDrives({ drive }),
    port: PORT,
    dataDir: null,
    snapshotDir: null,
    autoLookups: false,
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

const opts = { ratings: true, readColumn: 'read', dateColumn: 'date_read', keepUnmatched: false };

describe('Calibre import (§14)', () => {
  it('previews matches by path and by ISBN, and offers the custom columns', async () => {
    const p = (await api.post('/api/calibre/preview', { path: library, ...opts })).body;
    expect(p.books).toBe(3);
    expect(p.inScannedFolder).toBe(true);
    expect(p.counts).toEqual({ already: 0, files: 1, isbn: 1, none: 1 });
    expect(p.columns.map((c: { label: string }) => c.label)).toEqual(['read', 'date_read']);
    expect(p.rows[0]).toMatchObject({
      outcome: 'files',
      itemId: itemOf('The Quiet Cartographer - Juno Tarrant.epub'),
      applies: ['rating 8/10', 'read on 2024-05-17'],
    });
    // Calibre's 0 is "unrated", never a rating of 0 or 1.
    expect(p.rows[1].applies).toEqual([]);
  });

  it('imports Calibre’s facts as a match, and the owner’s data only as chosen', async () => {
    const r = (await api.post('/api/calibre/import', { path: library, ...opts })).body;
    expect(r).toEqual({ matched: 2, added: 0, skipped: 1, already: 0 });
    const q = itemOf('The Quiet Cartographer - Juno Tarrant.epub');
    expect(db.prepare('SELECT identity, match_source FROM items WHERE id = ?').get(q)).toEqual({
      identity: 'accepted',
      match_source: 'calibre',
    });
    const item = (await api.get(`/api/items/${q}`)).body;
    expect(item.user).toMatchObject({
      progress: 'finished',
      finishedOn: '2024-05-17',
      finishedPrecision: 'exact',
      rating: 8,
    });
    expect(item.series).toMatchObject({ name: 'Lanterns of Ost', position: 2 });
  });

  it('brings no owner data when none is chosen', async () => {
    await api.post('/api/calibre/import', {
      path: library,
      ratings: false,
      readColumn: null,
      dateColumn: null,
      keepUnmatched: false,
    });
    const item = (
      await api.get(`/api/items/${itemOf('The Quiet Cartographer - Juno Tarrant.epub')}`)
    ).body;
    expect(item.user).toMatchObject({ progress: 'not_started', rating: null });
  });

  it('can be repeated without duplicates, and never overwrites the owner’s edits', async () => {
    await api.post('/api/calibre/import', { path: library, ...opts, keepUnmatched: true });
    const lexicon = db
      .prepare("SELECT id FROM items WHERE title = 'A Lexicon of Lost Weather'")
      .pluck()
      .get() as string;
    expect((await api.get(`/api/items/${lexicon}`)).body.user).toMatchObject({
      progress: 'finished',
      finishedPrecision: 'unknown',
    });
    const q = itemOf('The Quiet Cartographer - Juno Tarrant.epub');
    await api.patch(`/api/items/${q}`, { rating: 5 });
    const count = db.prepare('SELECT COUNT(*) FROM items').pluck().get();
    const p = (
      await api.post('/api/calibre/preview', { path: library, ...opts, keepUnmatched: true })
    ).body;
    expect(p.counts).toEqual({ already: 3, files: 0, isbn: 0, none: 0 });
    expect(p.rows[0].kept).toEqual(['rating: Calibre has 8/10, yours is 5/10']);
    await api.post('/api/calibre/import', { path: library, ...opts, keepUnmatched: true });
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(count);
    expect((await api.get(`/api/items/${q}`)).body.user.rating).toBe(5);
  });

  it('leaves the Calibre library untouched', async () => {
    const before = fs.readdirSync(library).sort();
    const hash = sha(path.join(library, 'metadata.db'));
    const mtime = fs.statSync(path.join(library, 'metadata.db')).mtimeMs;
    await api.post('/api/calibre/import', { path: library, ...opts, keepUnmatched: true });
    expect(fs.readdirSync(library).sort()).toEqual(before);
    expect(sha(path.join(library, 'metadata.db'))).toBe(hash);
    expect(fs.statSync(path.join(library, 'metadata.db')).mtimeMs).toBe(mtime);
  });

  it('says plainly when the folder isn’t a Calibre library', async () => {
    const r = await api.post('/api/calibre/preview', { path: path.join(drive, 'Other'), ...opts });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no metadata.db/);
  });
});
