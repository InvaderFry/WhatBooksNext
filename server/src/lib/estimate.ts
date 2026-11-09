import {
  COMIC_SECONDS_PER_PAGE,
  ESTIMATE_SPREAD,
  MANGA_SECONDS_PER_PAGE,
  WORDS_PER_PAGE,
  WPM_FICTION,
  WPM_NONFICTION,
  WPM_TECH,
} from '../config.ts';

/**
 * Durations (PLAN.md §12.3) and effort (§12.4). Pure.
 *
 * - Prose: words ÷ reading speed for the kind. Comics/manga: pages × seconds per page.
 * - No word count: pages × assumed words per page, always "rough".
 * - "Measured" means a word count from the file (prose) or a page count from the file (comics);
 *   only a measured length can be a confident fit.
 * - The ±20% range is an assumed spread, never a measured confidence.
 */

export interface LengthInput {
  kind: string | null;
  /** From the primary file. */
  words: number | null;
  pages: number | null;
  /** The primary file is a PDF of page images (comic or scan): pages, but no words to count. */
  pdfType?: string | null;
  /** Page count a source states for a typical edition (always rough). */
  sourcePages?: number | null;
  sourceName?: string | null;
}

export interface Duration {
  /** Minutes, the ±20% range. */
  low: number;
  high: number;
  /** Plain words: "from 84,000 words", "from 22 pages", "from about 320 pages (Open Library)". */
  basis: string;
  /** A count from the file itself; only these can be a confident fit (§12.3). */
  measured: boolean;
  unit: 'book' | 'volume' | 'issue';
}

const fmt = (n: number) => n.toLocaleString('en-US');

function wpm(kind: string | null): number {
  if (kind === 'tech') return WPM_TECH;
  if (kind === 'fiction') return WPM_FICTION;
  return WPM_NONFICTION;
}

export function unitFor(
  kind: string | null,
  volume: string | null,
  issue: string | null,
): Duration['unit'] {
  if (issue) return 'issue';
  if (volume && (kind === 'comic' || kind === 'manga')) return 'volume';
  return 'book';
}

export function estimateDuration(i: LengthInput, unit: Duration['unit'] = 'book'): Duration | null {
  const visual = i.kind === 'comic' || i.kind === 'manga';
  let minutes: number;
  let basis: string;
  let measured: boolean;
  if (visual && i.pages && i.pages > 0) {
    const s = i.kind === 'manga' ? MANGA_SECONDS_PER_PAGE : COMIC_SECONDS_PER_PAGE;
    minutes = (i.pages * s) / 60;
    basis = `from ${fmt(i.pages)} pages`;
    measured = true;
  } else if (!visual && i.words && i.words > 0) {
    minutes = i.words / wpm(i.kind);
    basis = `from ${fmt(i.words)} words`;
    measured = true;
  } else if (!visual && i.pages && i.pages > 0) {
    // A PDF with no text layer, or no word count: pages × assumed words per page (rough).
    minutes = (i.pages * WORDS_PER_PAGE) / wpm(i.kind);
    basis = `from ${fmt(i.pages)} pages, assuming ${WORDS_PER_PAGE} words a page`;
    measured = false;
  } else if (i.sourcePages && i.sourcePages > 0) {
    // A source's page count is for some printed edition, never measured (§12.3).
    minutes = visual
      ? (i.sourcePages * (i.kind === 'manga' ? MANGA_SECONDS_PER_PAGE : COMIC_SECONDS_PER_PAGE)) /
        60
      : (i.sourcePages * WORDS_PER_PAGE) / wpm(i.kind);
    basis = `from about ${fmt(i.sourcePages)} pages${i.sourceName ? ` (${i.sourceName})` : ''}`;
    measured = false;
  } else {
    return null;
  }
  return {
    low: Math.max(1, Math.round(minutes * (1 - ESTIMATE_SPREAD))),
    high: Math.max(1, Math.round(minutes * (1 + ESTIMATE_SPREAD))),
    basis,
    measured,
    unit,
  };
}

/** "~15–25 min", "~4–5 h", "~12–18 h". */
export function formatRange(d: Pick<Duration, 'low' | 'high'>): string {
  const h = (m: number) => m / 60;
  if (d.high < 60) {
    const a = roundTo(d.low, 5);
    const b = roundTo(d.high, 5);
    return a === b ? `~${a} min` : `~${a}–${b} min`;
  }
  const lo = h(d.low);
  const hi = h(d.high);
  const r = (x: number) => (x < 10 ? Math.round(x * 2) / 2 : Math.round(x));
  const a = r(lo);
  const b = Math.max(r(hi), a);
  return a === b ? `~${a} h` : `~${a}–${b} h`;
}

function roundTo(n: number, step: number): number {
  return Math.max(step, Math.round(n / step) * step);
}

/**
 * Remaining time for an in-progress book, from its bucket (§12.3): always rough. The buckets'
 * midpoints: Sampled ~5%, Into it ~25%, Halfway 50%, Nearly done ~85%.
 */
const DONE_SHARE: Record<string, number> = {
  sampled: 0.05,
  into_it: 0.25,
  halfway: 0.5,
  nearly_done: 0.85,
};

export function remaining(d: Duration, progress: string): Duration | null {
  const share = DONE_SHARE[progress];
  if (share === undefined) return null;
  return {
    ...d,
    low: Math.max(1, Math.round(d.low * (1 - share))),
    high: Math.max(1, Math.round(d.high * (1 - share))),
    measured: false,
    basis: `${d.basis}, less what you’ve read (rough)`,
  };
}

export type Effort = 'light' | 'medium' | 'heavy' | 'unknown';

/**
 * Effort (§12.4): how demanding, separate from length. From kind and reference/tech signals
 * only, for now; a readability sample from the text needs another read of every file, which
 * waits until the next deep-pass change (M3 notes). Rough, and the owner's override wins.
 */
export function estimateEffort(kind: string | null, isReference: boolean): Effort {
  if (kind === 'tech') return 'heavy';
  if (isReference) return 'medium';
  if (kind === 'comic' || kind === 'manga' || kind === 'self_help') return 'light';
  return 'unknown';
}
