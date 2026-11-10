import { describe, expect, it } from 'vitest';
import { item, rated } from '../testing/rank.ts';
import { computeStats } from './stats.ts';

const TODAY = '2026-11-10';
const stats = (items: ReturnType<typeof item>[], folders = new Map<string, string[]>()) =>
  computeStats({ items, folders, folderNames: new Map([['f1', 'E:\\Books']]), today: TODAY });

const minutes = (low: number, high: number, measured = true) => ({
  low,
  high,
  basis: 'from some words',
  measured,
  unit: 'book' as const,
});

describe('Stats (§15)', () => {
  it('scenario 6: a book marked Already read with no date counts in no year', () => {
    const s = stats([
      item({ user: { progress: 'finished', finishedPrecision: 'unknown' } }),
      item({
        user: { progress: 'finished', finishedOn: '2026-03-02', finishedPrecision: 'exact' },
      }),
    ]);
    expect(s.finishes.total).toBe(2);
    expect(s.finishes.undated).toBe(1);
    expect(s.finishes.thisYear).toBe(1);
    expect(s.finishes.byYear).toEqual([
      { year: 2026, finished: 1, byKind: [{ key: 'fiction', count: 1 }] },
    ]);
  });

  it('scenario 20: a finished collection counts one reading, not one per issue it holds', () => {
    const collection = item({
      kind: 'comic',
      user: { progress: 'finished', finishedOn: '2026-05', finishedPrecision: 'approximate' },
    });
    const issues = [1, 2, 3].map(() => item({ kind: 'comic', via: 'collection' }));
    const s = stats([collection, ...issues]);
    expect(s.finishes.total).toBe(1);
    expect(s.finishes.thisYear).toBe(1);
    expect(s.readRate.byKind).toEqual([{ key: 'comic', label: 'comic', finished: 1, owned: 4 }]);
    // Issues read through the collection aren't waiting to be read.
    expect(s.backlog.total.items).toBe(0);
  });

  it('scenario 22: shows data coverage by kind with zero keys', () => {
    const s = stats([
      item({ kind: 'fiction', community: rated(70), duration: minutes(100, 150) }),
      item({ kind: 'fiction' }),
      item({ kind: 'comic' }),
    ]);
    expect(s.coverage).toEqual([
      { kind: 'fiction', items: 2, rated: 1, lengthKnown: 1, seriesKnown: 0 },
      { kind: 'comic', items: 1, rated: 0, lengthKnown: 0, seriesKnown: 0 },
    ]);
  });

  it('adds up the backlog estimate from known lengths only, and says how many have one', () => {
    const s = stats([
      item({ duration: minutes(100, 150) }),
      item({ duration: minutes(200, 300), user: { progress: 'halfway' } }),
      item({}),
    ]);
    expect(s.backlog.total).toMatchObject({ items: 3, inProgress: 1, withLength: 2 });
    // The halfway book adds what's left of it: half its range.
    expect(s.backlog.total.low).toBe(200);
    expect(s.backlog.total.high).toBe(300);
  });

  it('leaves Never and reference books out of the backlog, and counts what it left out', () => {
    const s = stats([
      item({ user: { triage: 'never' } }),
      item({ isReference: true }),
      item({ historyOnly: true }),
      item({ user: { progress: 'dnf', dnfReason: 'not_now' } }),
      item({}),
    ]);
    expect(s.backlog.total.items).toBe(1);
    expect(s.backlog.leftOut).toEqual({ never: 1, reference: 1 });
    expect(s.never).toEqual({ total: 1, byKind: [{ key: 'fiction', count: 1 }] });
  });

  it('compares this year with last year up to the same date, from the dates that can be placed', () => {
    const fin = (finishedOn: string, finishedPrecision = 'exact') =>
      item({ user: { progress: 'finished', finishedOn, finishedPrecision } });
    const s = stats([
      fin('2026-01-05'),
      fin('2025-02-01'),
      fin('2025-12-24'),
      fin('2025-06', 'approximate'),
      fin('2025-11', 'approximate'), // this very month last year: can't say
      fin('2025', 'approximate'),
    ]);
    expect(s.finishes).toMatchObject({
      thisYear: 1,
      lastYear: 5,
      lastYearToDate: 2,
      lastYearUnplaced: 2,
    });
  });

  it('states the denominator of each read rate, by kind and by folder', () => {
    const a = item({ user: { progress: 'finished' } });
    const b = item({});
    const c = item({ historyOnly: true, user: { progress: 'finished' } });
    const s = stats(
      [a, b, c],
      new Map([
        [a.id, ['f1']],
        [b.id, ['f1']],
      ]),
    );
    expect(s.readRate.byFolder).toEqual([{ key: 'f1', label: 'E:\\Books', finished: 1, owned: 2 }]);
    expect(s.readRate.byKind[0]).toMatchObject({ finished: 1, owned: 2 });
    expect(s.finishes).toMatchObject({ total: 2, readElsewhere: 1 });
  });

  it('counts DNF reasons, your ratings and takeaways', () => {
    const s = stats([
      item({ user: { progress: 'dnf', dnfReason: 'not_for_me', rating: 3 } }),
      item({ user: { progress: 'dnf' } }),
      item({ title: 'Kept', user: { rating: 9, takeaway: '  Maps are arguments. ' } }),
    ]);
    expect(s.dnf.byReason).toEqual(
      expect.arrayContaining([
        { key: 'not_for_me', count: 1 },
        { key: 'no_reason', count: 1 },
      ]),
    );
    expect(s.ratings).toMatchObject({ count: 2, mean: 6 });
    expect(s.ratings.distribution).toHaveLength(10);
    expect(s.ratings.distribution.find((d) => d.key === '9')?.count).toBe(1);
    expect(s.takeaways).toEqual([
      expect.objectContaining({ title: 'Kept', takeaway: 'Maps are arguments.' }),
    ]);
  });
});
