import { describe, expect, it } from 'vitest';
import {
  dueAt,
  dueItems,
  freshEstimate,
  hash01,
  refreshGroup,
  retryAt,
  type RefreshRow,
} from './refresh.ts';

/** Ratings plan stage 4: when each source is asked again (pure, fake clock). */

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const row = (over: Partial<RefreshRow> = {}): RefreshRow => ({
  itemId: 'item-a',
  source: 'openlibrary',
  outcome: 'matched',
  lookedUpAt: iso(T0),
  lastAnswerAt: iso(T0),
  nextEligibleAt: null,
  failureCount: 0,
  active: false,
  quiet: false,
  wellRated: true,
  ...over,
});

/** Days after T0 when the row falls due. */
const dueDays = (r: RefreshRow) => (dueAt(r)! - T0) / DAY;

describe('refresh groups', () => {
  it('asks weekly about a book in progress or shortlisted, from every source', () => {
    for (const source of ['openlibrary', 'metron', 'comicvine'] as const) {
      expect(refreshGroup(row({ source, active: true }))).toBe('active');
      expect(dueDays(row({ source, active: true }))).toBeGreaterThanOrEqual(7);
      expect(dueDays(row({ source, active: true }))).toBeLessThan(7.71);
    }
  });

  it('asks monthly where a rating source has no supported trusted rating anywhere', () => {
    for (const outcome of ['none', 'tie', 'provisional', 'matched'])
      expect(refreshGroup(row({ outcome, wellRated: false }))).toBe('open');
    expect(dueDays(row({ wellRated: false }))).toBeGreaterThanOrEqual(30);
    expect(dueDays(row({ wellRated: false }))).toBeLessThan(33.01);
  });

  it('asks every three months once ratings are settled, and Metron-only comics always', () => {
    expect(refreshGroup(row({ wellRated: true }))).toBe('settled');
    expect(refreshGroup(row({ source: 'metron', wellRated: false }))).toBe('settled');
    expect(refreshGroup(row({ source: 'comicvine', wellRated: false }))).toBe('settled');
    expect(dueDays(row())).toBeGreaterThanOrEqual(90);
  });

  it('asks rarely about books marked Never or read elsewhere, even with no rating', () => {
    expect(refreshGroup(row({ quiet: true, wellRated: false }))).toBe('settled');
  });

  it('moves a book between groups as it changes', () => {
    // Started reading: weekly. Its rating became supported: back to every three months.
    expect(refreshGroup(row({ wellRated: false }))).toBe('open');
    expect(refreshGroup(row({ wellRated: false, active: true }))).toBe('active');
    expect(refreshGroup(row({ wellRated: true, active: false }))).toBe('settled');
  });

  it('never schedules a ComicVine lookup skipped because Metron found the issue', () => {
    expect(dueAt(row({ source: 'comicvine', outcome: 'skipped' }))).toBeNull();
  });

  it('spreads books looked up on the same day over a few days, the same way every time', () => {
    const days = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => dueDays(row({ itemId: id })));
    expect(new Set(days.map((d) => d.toFixed(3))).size).toBe(days.length);
    for (const d of days) expect(d).toBeLessThan(99.01);
    expect(dueDays(row({ itemId: 'a' }))).toBe(days[0]);
    for (const k of ['x', 'y', 'z']) expect(hash01(k)).toBeLessThan(1);
  });
});

describe('failures and allowances', () => {
  it('retries a failed lookup after 1, 3 and 7 days, then returns to its group', () => {
    const failed = (n: number) =>
      dueDays(row({ outcome: 'failed', failureCount: n, lastAnswerAt: iso(T0 - 400 * DAY) }));
    expect(failed(1)).toBeGreaterThanOrEqual(1);
    expect(failed(1)).toBeLessThan(1.11);
    expect(failed(2)).toBeGreaterThanOrEqual(3);
    expect(failed(3)).toBeGreaterThanOrEqual(7);
    expect(failed(3)).toBeLessThan(7.71);
    expect(failed(4)).toBeGreaterThanOrEqual(90);
    expect(retryAt('item-a', 'openlibrary', 4, iso(T0))).toBeNull();
    expect(Date.parse(retryAt('item-a', 'openlibrary', 2, iso(T0))!)).toBe(
      dueAt(row({ outcome: 'failed', failureCount: 2 })),
    );
  });

  it('waits for the next day when the daily allowance ran out', () => {
    const tomorrow = iso(T0 + 0.5 * DAY);
    const r = row({ lastAnswerAt: iso(T0 - 400 * DAY), nextEligibleAt: tomorrow });
    expect(dueAt(r)).toBe(Date.parse(tomorrow));
  });

  it('asks a source that never answered as soon as it is allowed', () => {
    expect(dueAt(row({ outcome: 'failed', lastAnswerAt: null }))).toBe(T0);
  });
});

describe('what a check picks first', () => {
  it('puts in-progress and shortlisted books first, then the most overdue', () => {
    const now = T0 + 200 * DAY;
    const rows = [
      row({ itemId: 'settled-old', lastAnswerAt: iso(T0 - 100 * DAY) }),
      row({ itemId: 'settled-older', lastAnswerAt: iso(T0 - 300 * DAY) }),
      row({ itemId: 'reading', active: true, lastAnswerAt: iso(T0 + 190 * DAY) }),
      row({ itemId: 'not-due', lastAnswerAt: iso(now - DAY) }),
    ];
    expect(dueItems(rows, now).map((d) => d.itemId)).toEqual([
      'reading',
      'settled-older',
      'settled-old',
    ]);
  });

  it('gathers a book’s due sources together', () => {
    const now = T0 + 200 * DAY;
    const d = dueItems(
      [row({ source: 'openlibrary' }), row({ source: 'hardcover' }), row({ source: 'demo' })],
      now,
    );
    expect(d).toHaveLength(1);
    expect(d[0]!.sources).toEqual(['openlibrary', 'hardcover', 'demo']);
  });
});

describe('the estimate before Look up all books again', () => {
  it('counts requests, the polite spacing and the days Hardcover’s allowance needs', () => {
    const books = Array.from({ length: 3000 }, () => ['openlibrary', 'hardcover'] as const);
    const e = freshEstimate(books.map((b) => [...b]));
    expect(e.books).toBe(3000);
    expect(e.requests).toBe(3000 * 3);
    // 2 Hardcover requests a book, one a second: about 1.7 hours.
    expect(e.hours).toBeCloseTo(1.7, 1);
    // 6,000 Hardcover requests need two days of 4,800.
    expect(e.days).toBe(2);
  });

  it('leaves out ComicVine where Metron is asked first', () => {
    expect(freshEstimate([['metron', 'comicvine']]).requests).toBe(2);
    expect(freshEstimate([]).days).toBe(0);
  });
});
