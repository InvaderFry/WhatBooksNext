/**
 * Series order and gaps (PLAN.md §8, §12.5, §13.4). Pure: members in, gaps out, so the ranking
 * and the item page say the same thing.
 *
 * A gap is a whole number in a series' order that the owner neither owns nor has read. Gaps
 * warn, they never block (§13.10): the next owned installment stays selectable, and nothing
 * unowned is ever offered as if owned.
 */

export type SeriesUnit = 'volume' | 'issue';

/** What the owner has of one installment. */
export type Holding =
  /** A file (present, online-only or on an unplugged drive) or a store copy. */
  | 'owned'
  /** Owned as files, but every file is missing. */
  | 'unavailable'
  /** Read elsewhere, not owned (a history-only item). */
  | 'read_elsewhere';

export interface SeriesMember {
  id: string;
  position: number | null;
  unit: SeriesUnit;
  holding: Holding;
}

export interface Gap {
  /** First and last missing number (inclusive). */
  from: number;
  to: number;
  /** 'not_owned': neither owned nor read. 'unavailable': owned, but its files are missing. */
  state: 'not_owned' | 'unavailable';
  unit: SeriesUnit;
}

/**
 * Longest stretch worth checking. A "#2019" issue number that is really a year, or a typo,
 * must not produce two thousand gaps.
 */
const MAX_SPAN = 500;

/**
 * The gaps in one unit's order. Volumes count from 1: owning only volume 4 means volumes 1–3
 * are missing. Issue runs often start part-way (a new run, a bundle that begins at #13), so
 * issues only count gaps *between* issues the owner has or has read.
 *
 * Installments with no number, and numbers like 1.5 (side stories), are left out: they never
 * fill a gap and never make one.
 */
export function seriesGaps(members: SeriesMember[], unit: SeriesUnit): Gap[] {
  const at = new Map<number, Holding[]>();
  for (const m of members) {
    if (m.unit !== unit || m.position === null || !Number.isInteger(m.position)) continue;
    if (m.position < 0) continue;
    if (!at.has(m.position)) at.set(m.position, []);
    at.get(m.position)!.push(m.holding);
  }
  if (at.size === 0) return [];
  const known = [...at.keys()].sort((a, b) => a - b);
  const last = known.at(-1)!;
  // Volume 0 is a prequel: nothing says volume 1 must follow it, so counting starts at 1.
  const first = unit === 'volume' ? 1 : Math.max(known[0]!, 0);
  if (last - first > MAX_SPAN) return [];

  const out: Gap[] = [];
  const push = (p: number, state: Gap['state']) => {
    const prev = out.at(-1);
    if (prev && prev.state === state && prev.to === p - 1) prev.to = p;
    else out.push({ from: p, to: p, state, unit });
  };
  for (let p = first; p <= last; p++) {
    const h = at.get(p) ?? [];
    if (h.includes('owned') || h.includes('read_elsewhere')) continue;
    push(p, h.includes('unavailable') ? 'unavailable' : 'not_owned');
  }
  return out;
}

/** "volume 3", "volumes 3–5", "issue 12", "issues 12–14". */
export function gapNumbers(g: Pick<Gap, 'from' | 'to' | 'unit'>): string {
  return g.from === g.to ? `${g.unit} ${g.from}` : `${g.unit}s ${g.from}–${g.to}`;
}

/** The plain sentence for one gap, seen from an installment at `position` (or null). */
export function gapSentence(g: Gap, position: number | null): string {
  const what = gapNumbers(g);
  const plural = g.from !== g.to;
  const prefix = position !== null && g.from > position ? 'Gap ahead' : 'Gap';
  if (g.state === 'unavailable')
    return `${prefix}: ${what} ${plural ? 'are' : 'is'} owned, but the file${plural ? 's are' : ' is'} missing.`;
  return `${prefix}: ${what} ${plural ? 'aren’t' : 'isn’t'} recorded as owned or read.`;
}

/** Owned, not counting history-only entries or files that are all missing. */
export function ownedCount(members: SeriesMember[]): number {
  return members.filter((m) => m.holding === 'owned').length;
}

/** Numbers after the last one known, up to the source's stated total (finished series only). */
export function missingAfter(
  members: SeriesMember[],
  unit: SeriesUnit,
  total: number | null,
): { from: number; to: number } | null {
  if (total === null || unit !== 'volume') return null;
  const nums = members
    .filter((m) => m.unit === unit && m.position !== null && Number.isInteger(m.position))
    .map((m) => m.position!);
  const last = nums.length ? Math.max(...nums) : 0;
  return last < total ? { from: last + 1, to: total } : null;
}

/** Shows a number the way people write it: 3, 1.5. */
export function positionLabel(p: number): string {
  return Number.isInteger(p) ? String(p) : String(Math.round(p * 100) / 100);
}
