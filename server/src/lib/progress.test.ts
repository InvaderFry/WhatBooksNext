import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../db/database.ts';
import { memoryDb } from '../testing/helpers.ts';
import { applyUserPatch, type UserPatch } from './progress.ts';
import { createStoreItem } from './store.ts';

/**
 * Reading dates that can't be right are refused (review fixes 2026-11, Stage 1; owner decisions
 * D1 to D3). Book names are invented.
 */

const TODAY = '2026-11-15';
let db: DB;
let id: string;

const patch = (p: UserPatch) => applyUserPatch(db, id, p, TODAY);
const row = () =>
  db
    .prepare(
      'SELECT progress, started_on, started_precision, finished_on, finished_precision, rating FROM user_item WHERE item_id = ?',
    )
    .get(id) as Record<string, unknown>;
const refusal = (p: UserPatch) => {
  try {
    patch(p);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeEach(async () => {
  db = await memoryDb();
  id = createStoreItem(db, { title: 'The Lantern Road', author: 'Isla Fenwick', store: 'kindle' });
});

describe('reading dates', () => {
  it('refuses a finish date in the future', () => {
    patch({ progress: 'finished' });
    expect(refusal({ finishedOn: '2026-11-16' })).toMatch(/future/);
    expect(refusal({ finishedOn: '2026-12' })).toMatch(/future/);
    expect(refusal({ finishedOn: '2027' })).toMatch(/future/);
    expect(row().finished_on).toBe(TODAY);
  });

  it('refuses a start date in the future', () => {
    expect(refusal({ startedOn: '2027-01-02' })).toMatch(/future/);
    expect(row().started_on).toBeNull();
  });

  it('accepts today, and a month or year that has begun', () => {
    patch({ progress: 'finished', finishedOn: TODAY });
    patch({ finishedOn: '2026-11' });
    patch({ finishedOn: '2026' });
    patch({ startedOn: '2026-11', startedPrecision: 'approximate' });
    expect(row()).toMatchObject({ finished_on: '2026', started_on: '2026-11' });
  });

  it('refuses a start after the finish when both are exact days', () => {
    patch({ progress: 'finished', finishedOn: '2024-05-10' });
    expect(refusal({ startedOn: '2024-05-11' })).toMatch(/start date is after the finish/);
    patch({ startedOn: '2024-05-01' });
    expect(refusal({ finishedOn: '2024-04-30' })).toMatch(/start date is after the finish/);
    expect(row()).toMatchObject({ started_on: '2024-05-01', finished_on: '2024-05-10' });
  });

  it('allows a start after the finish when either date is approximate', () => {
    patch({ progress: 'finished', finishedOn: '2024-05' });
    patch({ startedOn: '2024-05-20' });
    patch({ startedOn: '2024', finishedOn: '2023-12-31', finishedPrecision: 'exact' });
    expect(row()).toMatchObject({ started_on: '2024', finished_on: '2023-12-31' });
  });

  it('refuses a finish date on a book that isn’t marked finished', () => {
    patch({ progress: 'halfway', startedOn: '2024-05-01' });
    expect(refusal({ finishedOn: '2024-05-10' })).toBe('Mark the book finished first.');
    expect(refusal({ progress: 'reading', finishedOn: '2024-05-10' })).toBe(
      'Mark the book finished first.',
    );
    expect(row()).toMatchObject({ progress: 'halfway', finished_on: null });
    // Finishing and dating it in one go is fine.
    patch({ progress: 'finished', finishedOn: '2024-05-10' });
    expect(row()).toMatchObject({ progress: 'finished', finished_on: '2024-05-10' });
  });

  it('lets an older impossible date stand while the rating changes', () => {
    patch({ progress: 'halfway' });
    db.prepare(
      "UPDATE user_item SET started_on = '2031-01-01', started_precision = 'exact', finished_on = '2030-01-01', finished_precision = 'exact' WHERE item_id = ?",
    ).run(id);
    patch({ rating: 8 });
    patch({ note: 'Slow start.' });
    expect(row()).toMatchObject({ rating: 8, started_on: '2031-01-01', finished_on: '2030-01-01' });
  });
});
