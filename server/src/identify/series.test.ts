import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import type { DB } from '../db/database.ts';
import { addCoverage, seriesIdFor, suggestCoverageFromSources } from '../lib/coverage.ts';
import { createStoreItem } from '../lib/store.ts';
import { loadRankData } from '../lib/rankData.ts';
import { readNext } from '../lib/recommend.ts';
import { markReadElsewhere, setSeriesStatus } from '../lib/seriesView.ts';
import { ensureUserRow } from '../lib/progress.ts';
import type { SourceRecord } from '../sources/types.ts';
import { fakePlatformWithDrives, memoryDb } from '../testing/helpers.ts';
import { applyIdentity } from './lookups.ts';
import { seriesKey, syncSeries } from './series.ts';

let db: DB;
beforeEach(async () => {
  db = await memoryDb();
});
afterEach(() => {
  db.close();
});

function putMatch(id: string, rec: SourceRecord) {
  db.prepare('DELETE FROM item_matches WHERE item_id = ?').run(id);
  db.prepare(
    `INSERT INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
    VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
  ).run(
    id,
    rec.source,
    rec.sourceId,
    JSON.stringify({ title: 1, author: 'unknown', isbn: 'none', notes: [] }),
    JSON.stringify(rec),
    new Date().toISOString(),
  );
  ensureUserRow(db, id);
  db.prepare('UPDATE user_item SET match_override = ? WHERE item_id = ?').run(
    `${rec.source}:${rec.sourceId}`,
    id,
  );
  applyIdentity(db, id);
}
function issue(run: string, year?: number, n = 1, source: 'metron' | 'comicvine' = 'metron') {
  const id = createStoreItem(db, {
    title: `Copperline #${n} (${run})`,
    kind: 'comic',
    store: 'globalcomix',
    series: 'Copperline',
  });
  db.prepare('UPDATE items SET issue_label = ? WHERE id = ?').run(String(n), id);
  const rec: SourceRecord = {
    source,
    sourceId: `${run}-${n}`,
    title: `Copperline #${n}`,
    authors: [],
    isbns: [],
    subjects: ['Comics'],
    format: 'ISSUE',
    firstPublishYear: 2025,
    series: {
      name: 'Copperline',
      id: run,
      position: n,
      status: 'ongoing',
      ...(year === undefined ? {} : { startYear: year }),
    },
  };
  putMatch(id, rec);
  return { id, rec };
}
function collection(year?: number) {
  const id = createStoreItem(db, {
    title: `Copperline Vol. 1 (${year ?? 'unknown'})`,
    kind: 'comic',
    store: 'kindle',
    series: 'Copperline',
    number: '1',
  });
  const rec: SourceRecord = {
    source: 'metron',
    sourceId: `trade-${year ?? 'unknown'}`,
    title: 'Copperline Vol. 1',
    authors: [],
    isbns: [],
    subjects: ['Comics'],
    format: 'COLLECTED',
    series: {
      name: 'Copperline',
      id: `trade-series-${year ?? 'unknown'}`,
      position: 1,
      status: 'ongoing',
    },
    collects: [1, 2, 3].map((n) => ({
      series: 'Copperline',
      number: String(n),
      ...(year === undefined ? {} : { year }),
    })),
  };
  putMatch(id, rec);
  return id;
}
const sid = (id: string) =>
  db.prepare('SELECT series_id FROM items WHERE id = ?').pluck().get(id) as string;

describe('known comic run identity', () => {
  it('keeps distinct trusted runs separate and recommends one issue from each', () => {
    const a = issue('first', 2019),
      b = issue('restart', 2024);
    syncSeries(db);
    expect(sid(a.id)).not.toBe(sid(b.id));
    const rank = loadRankData(db, new Map());
    const picks = readNext(
      rank.items,
      {
        budget: null,
        mode: 'read_for',
        readyToRead: false,
        exclude: new Set(),
        today: '2026-11-09',
        recentDays: 60,
      },
      { offset: 0, limit: 10 },
    );
    expect(picks.cards).toHaveLength(2);
  });

  it('uses certain comic run evidence even when Calibre supplies the first series match', () => {
    const a = issue('first', 2019),
      b = issue('restart', 2024);
    for (const { id } of [a, b]) {
      const rec: SourceRecord = {
        source: 'calibre',
        sourceId: `calibre-${id}`,
        title: 'Copperline',
        authors: [],
        isbns: [],
        subjects: [],
        series: { name: 'Copperline', position: 1, status: 'unknown' },
      };
      db.prepare(
        `INSERT INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
        VALUES (?, 'calibre', ?, 1, 1, ?, ?, ?)`,
      ).run(
        id,
        rec.sourceId,
        JSON.stringify({ title: 1, author: 'unknown', isbn: 'none', notes: [] }),
        JSON.stringify(rec),
        new Date().toISOString(),
      );
      db.prepare('UPDATE user_item SET match_override = NULL WHERE item_id = ?').run(id);
      applyIdentity(db, id);
    }
    syncSeries(db);
    expect(sid(a.id)).not.toBe(sid(b.id));
    // An unrelated accepted Calibre record does not make a provisional comic match certain.
    db.prepare("UPDATE item_matches SET score = 0.8 WHERE item_id = ? AND source = 'metron'").run(
      b.id,
    );
    applyIdentity(db, b.id);
    syncSeries(db);
    expect(db.prepare('SELECT match_key FROM series WHERE id = ?').pluck().get(sid(b.id))).toBe(
      'c:copperline',
    );
  });

  it('does not apply a collection from a different stated run to the only owned issue run', () => {
    const a = issue('first', 2019),
      trade = collection(2024);
    syncSeries(db);
    expect(sid(trade)).not.toBe(sid(a.id));
    suggestCoverageFromSources(db);
    expect(
      db.prepare('SELECT COUNT(*) FROM collection_coverage WHERE item_id = ?').pluck().get(trade),
    ).toBe(0);
  });

  it('separates known provider runs without inventing start years from cover dates', () => {
    const a = issue('first'),
      b = issue('restart');
    syncSeries(db);
    expect(sid(a.id)).not.toBe(sid(b.id));
    expect(db.prepare('SELECT match_key FROM series WHERE id = ?').pluck().get(sid(a.id))).toBe(
      'c:copperline|run:metron:first',
    );
    expect(seriesIdFor(db, seriesKey('comic', 'Copperline'), 2025)).toBeNull();
  });

  it('keeps several provider runs distinct even when they started in the same year', () => {
    const a = issue('first', 2019),
      b = issue('restart', 2019);
    syncSeries(db);
    expect(sid(a.id)).not.toBe(sid(b.id));
    expect(seriesIdFor(db, seriesKey('comic', 'Copperline'), 2019)).toBeNull();
  });

  it('links providers by an explicit start year and leaves unknown issues unqualified', () => {
    const a = issue('first', 2019),
      b = issue('restart', 2024),
      cv = issue('cv-first', 2019, 2, 'comicvine');
    const unknown = createStoreItem(db, {
      title: 'Copperline #5',
      kind: 'comic',
      store: 'globalcomix',
      series: 'Copperline',
    });
    db.prepare("UPDATE items SET issue_label = '5' WHERE id = ?").run(unknown);
    syncSeries(db);
    expect(sid(cv.id)).toBe(sid(a.id));
    expect(sid(unknown)).not.toBe(sid(a.id));
    expect(sid(unknown)).not.toBe(sid(b.id));
    expect(db.prepare('SELECT match_key FROM series WHERE id = ?').pluck().get(sid(unknown))).toBe(
      'c:copperline',
    );
  });

  it('preserves ordinary single-run collections and links ambiguous-name coverage to its stated year', () => {
    const a = issue('first', 2019),
      trade = collection(2019);
    syncSeries(db);
    const original = sid(a.id);
    expect(sid(trade)).toBe(original);
    expect(seriesIdFor(db, seriesKey('comic', 'Copperline'))).toBe(original);
    const b = issue('restart', 2024);
    const unknown = collection();
    syncSeries(db);
    expect(sid(trade)).toBe(sid(a.id));
    expect(sid(trade)).not.toBe(sid(b.id));
    expect(sid(unknown)).not.toBe(sid(a.id));
    expect(seriesIdFor(db, seriesKey('comic', 'Copperline'))).toBeNull();
    suggestCoverageFromSources(db);
    expect(
      db.prepare('SELECT series_id FROM collection_coverage WHERE item_id = ?').pluck().get(trade),
    ).toBe(sid(a.id));
    expect(
      db.prepare('SELECT COUNT(*) FROM collection_coverage WHERE item_id = ?').pluck().get(unknown),
    ).toBe(0);
  });

  it('keeps qualified ids, owner status and coverage when later lookups add the start year', () => {
    const a = issue('first'),
      b = issue('restart'),
      trade = collection();
    syncSeries(db);
    const original = sid(a.id);
    setSeriesStatus(db, original, 'finished');
    addCoverage(db, trade, original, 1, 3);
    putMatch(a.id, { ...a.rec, series: { ...a.rec.series!, startYear: 2019 } });
    putMatch(b.id, { ...b.rec, series: { ...b.rec.series!, startYear: 2024 } });
    syncSeries(db);
    expect(sid(a.id)).toBe(original);
    expect(sid(trade)).toBe(original);
    expect(
      db.prepare('SELECT publication_status FROM series WHERE id = ?').pluck().get(original),
    ).toBe('finished');
    expect(seriesIdFor(db, seriesKey('comic', 'Copperline'), 2019)).toBe(original);
    syncSeries(db);
    expect(sid(a.id)).toBe(original);
  });

  it('keeps a read-elsewhere action attached to the explicitly selected run', () => {
    const a = issue('first', 2019),
      b = issue('restart', 2024);
    issue('first', 2019, 3);
    syncSeries(db);
    const made = markReadElsewhere(db, sid(a.id), 'issue', 2, 2);
    expect(made).toHaveLength(1);
    expect(sid(made[0]!)).toBe(sid(a.id));
    expect(sid(made[0]!)).not.toBe(sid(b.id));
    const selected = sid(a.id);
    db.prepare('DELETE FROM items WHERE id != ?').run(made[0]!);
    syncSeries(db);
    expect(sid(made[0]!)).toBe(selected);
    expect(
      JSON.parse(
        db.prepare('SELECT source_ids FROM series WHERE id = ?').pluck().get(selected) as string,
      ).runStartYear,
    ).toBe(2019);
  });

  it('shows distinguishable run labels in the series page and manual coverage selector', async () => {
    const a = issue('first', 2019),
      b = issue('restart', 2024),
      trade = collection();
    syncSeries(db);
    const app = createApp({
      db,
      platform: fakePlatformWithDrives({}),
      port: 4818,
      dataDir: null,
      snapshotDir: null,
      autoLookups: false,
    });
    try {
      const series = await request(app.app)
        .get(`/api/series/${sid(a.id)}`)
        .set('Host', 'localhost:4818');
      expect(series.body).toMatchObject({ name: 'Copperline', runLabel: '2019 run' });
      const preview = await request(app.app)
        .get(`/api/items/${trade}/coverage`)
        .set('Host', 'localhost:4818');
      expect(preview.body.series).toContainEqual({ id: sid(a.id), name: 'Copperline (2019 run)' });
      expect(preview.body.series).toContainEqual({ id: sid(b.id), name: 'Copperline (2024 run)' });
    } finally {
      await app.close();
    }
  });
});
