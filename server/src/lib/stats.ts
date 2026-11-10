import { remaining } from './estimate.ts';
import { coverageByKind, type KindCoverage } from './matchReport.ts';
import type { RankItem } from './recommend.ts';

/**
 * The Stats page (PLAN.md §15). Pure: items in, numbers out.
 *
 * Facts are kept apart from estimates. Facts are what the owner marked (finished, did not
 * finish, Never, ratings, dates) and what the files say. Estimates are reading times, which
 * rest on assumed reading speeds and an assumed ±20% spread.
 *
 * Rules:
 *  - Every reading is counted once: only what the owner marked counts. A collection's issues
 *    read "via collection" aren't extra finishes (§12.5, scenario 20).
 *  - A finish with no recorded date is listed apart and counted in no year (scenario 6).
 *  - Never and reference items are left out of backlog totals (they stay in the Library).
 *  - Progress buckets can't give pages read, so no such number is shown.
 *  - Every rate states its denominator.
 */

export const IN_PROGRESS = ['sampled', 'into_it', 'halfway', 'nearly_done'];

export interface Count {
  key: string;
  count: number;
}

export interface BacklogKind {
  kind: string;
  items: number;
  inProgress: number;
  /** How many have a known length; the hours below add up only these. */
  withLength: number;
  /** Minutes: the sum of each known length's range (what's left, for books in progress). */
  low: number;
  high: number;
}

export interface YearRow {
  year: number;
  finished: number;
  byKind: Count[];
}

export interface RateRow {
  key: string;
  /** Display name (a folder's path, or a kind id). */
  label: string;
  finished: number;
  /** Owned items there: the denominator. */
  owned: number;
}

export interface Takeaway {
  id: string;
  title: string;
  takeaway: string;
  finishedOn: string | null;
}

export interface Stats {
  today: string;
  library: {
    /** Owned items (files or store), not read-elsewhere entries. */
    owned: number;
    readElsewhere: number;
    reference: number;
    never: number;
    hidden: number;
  };
  coverage: KindCoverage[];
  backlog: {
    byKind: BacklogKind[];
    total: BacklogKind;
    leftOut: { never: number; reference: number };
  };
  finishes: {
    total: number;
    byYear: YearRow[];
    /** Finished with no recorded date: counted in no year. */
    undated: number;
    thisYear: number;
    lastYear: number;
    /** Last year's finishes up to today's date last year, from the dates that can be placed. */
    lastYearToDate: number;
    /** Last year's finishes whose date is too rough to say whether they came before today's date. */
    lastYearUnplaced: number;
    /** Read elsewhere (imported or marked), included above. */
    readElsewhere: number;
  };
  readRate: { byKind: RateRow[]; byFolder: RateRow[] };
  dnf: { total: number; byReason: Count[] };
  never: { total: number; byKind: Count[] };
  ratings: { count: number; mean: number | null; distribution: Count[] };
  takeaways: Takeaway[];
}

export interface StatsInput {
  items: RankItem[];
  /** Each owned item's library folders (an item can have copies in several). */
  folders: Map<string, string[]>;
  folderNames: Map<string, string>;
  today: string;
}

const kindOf = (i: RankItem) => i.kind ?? 'unknown';

function bump(m: Map<string, number>, k: string, n = 1) {
  m.set(k, (m.get(k) ?? 0) + n);
}

const toCounts = (m: Map<string, number>): Count[] =>
  [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

/** The year of a recorded finish, or null when its date is unknown. */
export function finishYear(i: Pick<RankItem, 'user'>): number | null {
  const d = i.user.finishedOn;
  if (!d || i.user.finishedPrecision === 'unknown') return null;
  const m = /^(\d{4})/.exec(d);
  return m ? Number(m[1]) : null;
}

/** Is this finish (last year) on or before today's month and day? null when its date is too rough. */
function onOrBefore(date: string, today: string): boolean | null {
  const md = today.slice(5); // MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date.slice(5) <= md;
  if (/^\d{4}-\d{2}$/.test(date)) {
    const month = date.slice(5, 7);
    if (month < md.slice(0, 2)) return true;
    if (month > md.slice(0, 2)) return false;
    return null; // this very month: can't tell
  }
  return null;
}

/** In the to-read pile: owned, not finished or stopped, not Never, not reference, not hidden. */
export function inBacklog(i: RankItem): boolean {
  if (i.historyOnly || i.user.hidden || i.isReference) return false;
  if (i.user.triage === 'never') return false;
  if (i.user.progress === 'finished' || i.user.progress === 'dnf') return false;
  // Read through a collection or its issues (§12.5): not waiting to be read.
  if (i.via) return false;
  return true;
}

export function computeStats(input: StatsInput): Stats {
  const { items, today } = input;
  const owned = items.filter((i) => !i.historyOnly);
  const thisYear = Number(today.slice(0, 4));

  // ---- Backlog (an estimate where it's hours) -------------------------------------------------
  const backlogBy = new Map<string, BacklogKind>();
  const total: BacklogKind = {
    kind: 'all',
    items: 0,
    inProgress: 0,
    withLength: 0,
    low: 0,
    high: 0,
  };
  let leftNever = 0;
  let leftReference = 0;
  for (const i of owned) {
    const open = i.user.progress !== 'finished' && i.user.progress !== 'dnf' && !i.via;
    if (open && !i.user.hidden) {
      if (i.user.triage === 'never') leftNever++;
      else if (i.isReference) leftReference++;
    }
    if (!inBacklog(i)) continue;
    const k = kindOf(i);
    const row = backlogBy.get(k) ?? {
      kind: k,
      items: 0,
      inProgress: 0,
      withLength: 0,
      low: 0,
      high: 0,
    };
    const started = IN_PROGRESS.includes(i.user.progress);
    const d = i.duration ? (started ? remaining(i.duration, i.user.progress) : i.duration) : null;
    for (const r of [row, total]) {
      r.items++;
      if (started) r.inProgress++;
      if (d) {
        r.withLength++;
        r.low += d.low;
        r.high += d.high;
      }
    }
    backlogBy.set(k, row);
  }

  // ---- Finishes (facts) -----------------------------------------------------------------------
  const finished = items.filter((i) => i.user.progress === 'finished');
  const years = new Map<number, { finished: number; kinds: Map<string, number> }>();
  let undated = 0;
  let lastYearToDate = 0;
  let lastYearUnplaced = 0;
  for (const i of finished) {
    const y = finishYear(i);
    if (y === null) {
      undated++;
      continue;
    }
    const row = years.get(y) ?? { finished: 0, kinds: new Map<string, number>() };
    row.finished++;
    bump(row.kinds, kindOf(i));
    years.set(y, row);
    if (y === thisYear - 1) {
      const before = onOrBefore(i.user.finishedOn!, today);
      if (before === null) lastYearUnplaced++;
      else if (before) lastYearToDate++;
    }
  }

  // ---- Read rate (facts, with denominators) ---------------------------------------------------
  const kindRate = new Map<string, RateRow>();
  const folderRate = new Map<string, RateRow>();
  for (const i of owned) {
    const done = i.user.progress === 'finished' ? 1 : 0;
    const k = kindOf(i);
    const kr = kindRate.get(k) ?? { key: k, label: k, finished: 0, owned: 0 };
    kr.owned++;
    kr.finished += done;
    kindRate.set(k, kr);
    for (const f of input.folders.get(i.id) ?? []) {
      const fr = folderRate.get(f) ?? {
        key: f,
        label: input.folderNames.get(f) ?? 'A removed folder',
        finished: 0,
        owned: 0,
      };
      fr.owned++;
      fr.finished += done;
      folderRate.set(f, fr);
    }
  }

  // ---- DNF, Never, ratings, takeaways ---------------------------------------------------------
  const dnfBy = new Map<string, number>();
  for (const i of items)
    if (i.user.progress === 'dnf') bump(dnfBy, i.user.dnfReason ?? 'no_reason');
  const neverBy = new Map<string, number>();
  for (const i of owned) if (i.user.triage === 'never') bump(neverBy, kindOf(i));
  const rated = items.filter((i) => i.user.rating !== null);
  const dist = new Map<string, number>();
  for (let r = 1; r <= 10; r++) dist.set(String(r), 0);
  for (const i of rated) bump(dist, String(i.user.rating));
  const takeaways = items
    .filter((i) => i.user.takeaway && i.user.takeaway.trim())
    .map((i) => ({
      id: i.id,
      title: i.title,
      takeaway: i.user.takeaway!.trim(),
      finishedOn: i.user.finishedPrecision === 'unknown' ? null : i.user.finishedOn,
    }))
    .sort((a, b) => (b.finishedOn ?? '').localeCompare(a.finishedOn ?? ''));

  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    today,
    library: {
      owned: owned.length,
      readElsewhere: items.length - owned.length,
      reference: owned.filter((i) => i.isReference).length,
      never: owned.filter((i) => i.user.triage === 'never').length,
      hidden: owned.filter((i) => i.user.hidden).length,
    },
    coverage: coverageByKind(items),
    backlog: {
      byKind: [...backlogBy.values()].sort((a, b) => b.items - a.items),
      total,
      leftOut: { never: leftNever, reference: leftReference },
    },
    finishes: {
      total: finished.length,
      byYear: [...years.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([year, r]) => ({ year, finished: r.finished, byKind: toCounts(r.kinds) })),
      undated,
      thisYear: years.get(thisYear)?.finished ?? 0,
      lastYear: years.get(thisYear - 1)?.finished ?? 0,
      lastYearToDate,
      lastYearUnplaced,
      readElsewhere: finished.filter((i) => i.historyOnly).length,
    },
    readRate: {
      byKind: [...kindRate.values()].sort((a, b) => b.owned - a.owned),
      byFolder: [...folderRate.values()].sort((a, b) => a.label.localeCompare(b.label)),
    },
    dnf: { total: sum(dnfBy), byReason: toCounts(dnfBy) },
    never: { total: sum(neverBy), byKind: toCounts(neverBy) },
    ratings: {
      count: rated.length,
      mean: rated.length
        ? Math.round((rated.reduce((a, i) => a + i.user.rating!, 0) / rated.length) * 10) / 10
        : null,
      distribution: [...dist.entries()].map(([key, count]) => ({ key, count })),
    },
    takeaways,
  };
}
