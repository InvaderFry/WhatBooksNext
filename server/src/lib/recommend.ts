import { EVENING_MINUTES, WEEKEND_MINUTES, WEIGHTS } from '../config.ts';
import { SOURCE_LABELS } from '../sources/types.ts';
import { formatRange, remaining, type Duration, type Effort } from './estimate.ts';
import type { AvailabilityView, UserData } from './library.ts';
import type { CommunityRating } from './ratings.ts';

/**
 * Choosing what to read (PLAN.md §13): eligibility, one-per-series, the weighted blend with
 * unknown = neutral, and "Why this pick". Pure — items, user data and settings in, ranking out
 * (§6.4), so it can later run in a browser unchanged.
 */

export interface RankItem {
  id: string;
  title: string;
  kind: string | null;
  isReference: boolean;
  creators: { name: string; role?: string }[];
  coverFileId: string | null;
  formats: string[];
  availability: AvailabilityView;
  user: UserData;
  identity: 'accepted' | 'provisional' | 'tie' | 'unidentified';
  /** The owner confirmed the match (or the match came from the item's own ISBN). */
  matchConfirmed: boolean;
  /** Only read elsewhere, not owned (§7 'history' location). Teaches taste, never recommended. */
  historyOnly: boolean;
  series: { key: string; name: string; position: number | null; label: string | null } | null;
  duration: Duration | null;
  community: CommunityRating | null;
  firstPublishYear: number | null;
  acquired: { date: string | null; basis: 'entered' | 'file_date' | 'first_seen' | 'unknown' };
  effort: Effort;
}

export type TimeMode = 'read_for' | 'finish_within';

export interface Situation {
  /** Minutes, or null for "any". */
  budget: number | null;
  mode: TimeMode;
  readyToRead: boolean;
  /** Books only, comics and manga only, or both (the owner asked for this after M3). */
  show?: 'all' | 'books' | 'comics';
  /** "Not in the mood" for this session (§13.8): ids hidden until the tab closes. */
  exclude: Set<string>;
  /** Today, YYYY-MM-DD (injectable for tests). */
  today: string;
  recentDays: number;
}

export const TIME_PRESETS: { id: string; label: string; minutes: number | null }[] = [
  { id: '30', label: '30 min', minutes: 30 },
  { id: '60', label: '1 h', minutes: 60 },
  { id: '120', label: '2 h', minutes: 120 },
  { id: 'evening', label: 'An evening', minutes: EVENING_MINUTES },
  { id: 'weekend', label: 'A weekend', minutes: WEEKEND_MINUTES },
  { id: 'any', label: 'Any length', minutes: null },
];

const IN_PROGRESS = ['sampled', 'into_it', 'halfway', 'nearly_done'];

// ---- Eligibility (§13.1) -------------------------------------------------------------------

/** Why an item is out of every mode, or null when it's eligible. */
export function ineligibleBecause(i: RankItem): string | null {
  if (i.historyOnly) return 'read elsewhere, not owned';
  if (i.user.hidden) return 'hidden';
  if (i.user.triage === 'never') return 'marked Never';
  if (i.user.progress === 'dnf') return 'did not finish';
  if (i.user.progress === 'finished') return 'finished';
  return null;
}

/**
 * One per series (§8): before ranking, each series offers only its next installment — an
 * in-progress one first, else the earliest unread one. Skipping ahead never marks anything read.
 * Items without a series are standalone.
 */
export function onePerSeries(items: RankItem[]): RankItem[] {
  const out: RankItem[] = [];
  const bySeries = new Map<string, RankItem[]>();
  for (const i of items) {
    if (!i.series) out.push(i);
    else {
      if (!bySeries.has(i.series.key)) bySeries.set(i.series.key, []);
      bySeries.get(i.series.key)!.push(i);
    }
  }
  for (const group of bySeries.values()) {
    const eligible = group.filter((i) => ineligibleBecause(i) === null);
    const pos = (i: RankItem) => i.series?.position ?? Number.POSITIVE_INFINITY;
    const ordered = [...eligible].sort((a, b) => pos(a) - pos(b) || a.title.localeCompare(b.title));
    const next = ordered.find((i) => IN_PROGRESS.includes(i.user.progress)) ?? ordered[0];
    if (next) out.push(next);
  }
  return out;
}

/** Has the owner read or started any other installment of this item's series? */
function seriesStarted(i: RankItem, all: RankItem[]): boolean {
  if (!i.series) return false;
  return all.some(
    (o) =>
      o.id !== i.id &&
      o.series?.key === i.series!.key &&
      (o.user.progress === 'finished' || IN_PROGRESS.includes(o.user.progress)),
  );
}

// ---- Components (§13.7): each 0–1, unknown = neutral ---------------------------------------

const NEUTRAL = 0.5;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function ratingComponent(i: RankItem): number {
  if (i.user.rating !== null) return (i.user.rating - 1) / 9;
  if (i.community) return clamp((i.community.score - 50) / 50);
  return NEUTRAL;
}

export type Fit = 'fits' | 'might_fit' | 'too_long' | 'unknown' | 'any';

/**
 * Does it fit the time? "Finish within": only a measured length whose high end is within the
 * budget is a confident fit; a rough one is "might fit" (§12.3). "Read for": any length works —
 * a long novel can fill a session (§13.2).
 */
export function fitOf(d: Duration | null, s: Pick<Situation, 'budget' | 'mode'>): Fit {
  if (s.budget === null) return 'any';
  if (s.mode === 'read_for') return d ? 'fits' : 'unknown';
  if (!d) return 'unknown';
  if (d.high <= s.budget) return d.measured ? 'fits' : 'might_fit';
  if (!d.measured && d.low <= s.budget) return 'might_fit';
  return 'too_long';
}

export function timeFitComponent(i: RankItem, s: Situation, d: Duration | null): number {
  if (s.budget === null || !d) return NEUTRAL;
  if (s.mode === 'finish_within') return fitOf(d, s) === 'fits' ? 1 : NEUTRAL;
  // Reading for a session: shorter isn't automatically better. Finishing in one sitting is a
  // small plus; a long book is still a good way to spend the time.
  return d.high <= s.budget ? 0.85 : 0.75;
}

export function momentumComponent(i: RankItem, all: RankItem[]): number {
  const p: Record<string, number> = { nearly_done: 1, halfway: 0.9, into_it: 0.8, sampled: 0.6 };
  if (p[i.user.progress] !== undefined) return p[i.user.progress]!;
  if (seriesStarted(i, all)) return 0.8;
  return 0;
}

export function triageComponent(i: RankItem): number {
  return i.user.triage === 'want' ? 1 : NEUTRAL;
}

function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

/** A gentle boost for books acquired recently (§13.7). Unknown and old get no boost. */
export function recencyComponent(i: RankItem, s: Situation): number {
  if (!i.acquired.date || i.acquired.basis === 'unknown') return 0;
  const d = daysBetween(i.acquired.date, s.today);
  return d >= 0 && d <= s.recentDays ? 1 : 0;
}

// ---- Cards (§13.3, §13.8) --------------------------------------------------------------------

export interface Card {
  id: string;
  title: string;
  kind: string | null;
  creators: { name: string; role?: string }[];
  coverFileId: string | null;
  formats: string[];
  availability: AvailabilityView;
  progress: string;
  shortlisted: boolean;
  /** "Whole book · ~4–5 h", "Next issue · ~15–25 min", "Starts a series · vol. 1". */
  scope: string;
  lengthBasis: string | null;
  fit: Fit;
  reasons: string[];
  limitations: string[];
  score: number;
  components: Record<keyof typeof WEIGHTS, number>;
}

function budgetText(m: number): string {
  if (m === EVENING_MINUTES) return 'an evening';
  if (m === WEEKEND_MINUTES) return 'a weekend';
  if (m < 60) return `${m} minutes`;
  return m === 60 ? '1 hour' : `${m / 60} hours`;
}

function sessionText(m: number): string {
  if (m === EVENING_MINUTES) return 'an evening';
  if (m === WEEKEND_MINUTES) return 'a weekend';
  return m < 60 ? `a ${m}-minute session` : `a ${m / 60}-hour session`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function ratingReason(c: CommunityRating): string {
  const src = SOURCE_LABELS[c.source];
  const raw = c.scale === 100 ? `${Math.round(c.raw)}/100` : `${c.raw.toFixed(1)}/5`;
  const votes = c.votes ? ` from ${fmt(c.votes)} rating${c.votes === 1 ? '' : 's'}` : '';
  return c.scope === 'series'
    ? `Series rated ${raw} on ${src}${votes}`
    : `Rated ${raw} by ${src} readers${votes}`;
}

function scopeText(i: RankItem, all: RankItem[], d: Duration | null): string {
  const len = d ? formatRange(d) : 'length unknown';
  const inProgress = IN_PROGRESS.includes(i.user.progress);
  if (inProgress && d) {
    const left = remaining(d, i.user.progress);
    if (left) return `Continue · ${formatRange(left)} left (rough)`;
  }
  if (i.series) {
    const label = i.series.label ? ` ${i.series.label}` : '';
    const owned = all.filter((o) => o.series?.key === i.series!.key).length;
    const unit = d?.unit === 'issue' ? 'issue' : 'vol.';
    if (seriesStarted(i, all)) return `Next in series ·${label ? ` ${unit}${label}` : ''} · ${len}`;
    return `Starts a series ·${label ? ` ${unit}${label} ·` : ''} ${owned} owned · ${len}`;
  }
  const whole =
    d?.unit === 'issue' ? 'One issue' : d?.unit === 'volume' ? 'One volume' : 'Whole book';
  return `${whole} · ${len}`;
}

export function buildCard(i: RankItem, all: RankItem[], s: Situation): Card {
  const d = i.duration;
  const fit = fitOf(d, s);
  const components = {
    rating: ratingComponent(i),
    timeFit: timeFitComponent(i, s, d),
    // Taste learning arrives in M5. Until then it is inert: neutral for everyone (§13.11).
    taste: NEUTRAL,
    momentum: momentumComponent(i, all),
    triage: triageComponent(i),
    recency: recencyComponent(i, s),
  };
  const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
    (a, k) => a + WEIGHTS[k] * components[k],
    0,
  );

  // Reasons: only what the data really says, strongest contribution first (§13.8).
  const reasons: { text: string; weight: number }[] = [];
  if (i.user.rating !== null)
    reasons.push({
      text: `You rated it ${i.user.rating}/10`,
      weight: WEIGHTS.rating * components.rating,
    });
  else if (i.community?.highlyRated)
    reasons.push({ text: ratingReason(i.community), weight: WEIGHTS.rating * components.rating });
  if (IN_PROGRESS.includes(i.user.progress))
    reasons.push({
      text:
        i.user.progress === 'nearly_done'
          ? 'You’re nearly done'
          : i.user.progress === 'halfway'
            ? 'You’re halfway through'
            : 'You’ve started it',
      weight: WEIGHTS.momentum * components.momentum,
    });
  else if (components.momentum > 0)
    reasons.push({
      text: 'Next in a series you’re reading',
      weight: WEIGHTS.momentum * components.momentum,
    });
  if (s.budget !== null && d && fit === 'fits')
    reasons.push({
      // "Finish" is only ever said of a measured length (§12.3).
      text:
        d.measured && d.high <= s.budget
          ? `You can finish it within ${budgetText(s.budget)}`
          : `Good for ${sessionText(s.budget)}`,
      weight: WEIGHTS.timeFit * components.timeFit,
    });
  if (i.user.triage === 'want')
    reasons.push({ text: 'You marked it Want', weight: WEIGHTS.triage * components.triage });
  if (components.recency > 0 && i.acquired.date) {
    const days = daysBetween(i.acquired.date, s.today);
    reasons.push({
      text: `Added ${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}${i.acquired.basis === 'file_date' ? ' (from the file date)' : ''}`,
      weight: WEIGHTS.recency,
    });
  }

  // Limitations: what the pick rests on less firmly, stated plainly (§13.8).
  const limits: string[] = [];
  if (!d) limits.push('length unknown');
  else if (!d.measured) limits.push('rough length');
  if (i.identity === 'provisional' && !i.matchConfirmed) limits.push('unconfirmed match');
  if (i.identity === 'tie') limits.push('two possible matches — check in Needs review');
  if (i.identity === 'unidentified' && i.kind !== 'comic')
    limits.push('not identified online: details from the file only');
  if (i.community?.scope === 'series') limits.push('rating is for the whole series');
  // "On external drive…" → "on external drive…", keeping names such as iCloud as they are.
  if (i.availability.label)
    limits.push(i.availability.label.charAt(0).toLowerCase() + i.availability.label.slice(1));

  return {
    id: i.id,
    title: i.title,
    kind: i.kind,
    creators: i.creators,
    coverFileId: i.coverFileId,
    formats: i.formats,
    availability: i.availability,
    progress: i.user.progress,
    shortlisted: i.user.shortlistPosition !== null,
    scope: scopeText(i, all, d),
    lengthBasis: d?.basis ?? null,
    fit,
    reasons: reasons
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((r) => r.text),
    limitations: limits,
    score: Math.round(score * 1000) / 1000,
    components,
  };
}

// ---- Read next (§13.10) -------------------------------------------------------------------

export interface ReadNextResult {
  cards: Card[];
  /** "Finish within" only: rough estimates that might fit, kept apart (§13.2). */
  mightFit: Card[];
  total: number;
  /** Eligible items before the time filter, and how many have a rating or a known length. */
  coverage: { eligible: number; rated: number; lengthKnown: number };
}

export function readNext(
  all: RankItem[],
  s: Situation,
  page: { offset: number; limit: number },
): ReadNextResult {
  const eligible = onePerSeries(
    all.filter(
      (i) =>
        ineligibleBecause(i) === null &&
        // Reference items appear only in Skim, topic interests and Still relevant? (§13.1).
        !i.isReference &&
        !s.exclude.has(i.id) &&
        (s.show === 'comics'
          ? i.kind === 'comic' || i.kind === 'manga'
          : s.show === 'books'
            ? i.kind !== 'comic' && i.kind !== 'manga'
            : true) &&
        (!s.readyToRead || i.availability.readyToRead),
    ),
  );
  const cards = eligible.map((i) => buildCard(i, all, s));
  const order = (a: Card, b: Card) => b.score - a.score || a.title.localeCompare(b.title);
  let main = cards;
  let mightFit: Card[] = [];
  if (s.mode === 'finish_within' && s.budget !== null) {
    main = cards.filter((c) => c.fit === 'fits');
    mightFit = cards
      .filter((c) => c.fit === 'might_fit')
      .sort(order)
      .slice(0, page.limit);
  }
  main.sort(order);
  return {
    cards: main.slice(page.offset, page.offset + page.limit),
    mightFit,
    total: main.length,
    coverage: {
      eligible: eligible.length,
      rated: eligible.filter((i) => i.community || i.user.rating !== null).length,
      lengthKnown: eligible.filter((i) => i.duration).length,
    },
  };
}
