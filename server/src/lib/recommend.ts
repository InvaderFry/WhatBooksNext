import { EVENING_MINUTES, SAME_AUTHOR_PENALTY, WEEKEND_MINUTES, WEIGHTS } from '../config.ts';
import { SOURCE_LABELS } from '../sources/types.ts';
import { formatRange, remaining, type Duration, type Effort } from './estimate.ts';
import type { AvailabilityView, UserData } from './library.ts';
import type { CommunityRating } from './ratings.ts';
import {
  gapSentence,
  ownedCount,
  seriesGaps,
  type Gap,
  type Holding,
  type SeriesMember,
  type SeriesUnit,
} from './series.ts';

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
  series: {
    /** The series id: one-per-series and gaps work on it. */
    key: string;
    name: string;
    position: number | null;
    label: string | null;
    unit: SeriesUnit;
    status: 'finished' | 'ongoing' | 'unknown';
    /** Installments a source says the finished story has; null when not stated. */
    total: number | null;
  } | null;
  duration: Duration | null;
  community: CommunityRating | null;
  firstPublishYear: number | null;
  acquired: { date: string | null; basis: 'entered' | 'file_date' | 'first_seen' | 'unknown' };
  effort: Effort;
}

export type TimeMode = 'read_for' | 'finish_within';

export type Show = 'all' | 'books' | 'tech' | 'comics';

export function shows(i: Pick<RankItem, 'kind'>, show: Show | undefined): boolean {
  const comic = i.kind === 'comic' || i.kind === 'manga';
  if (show === 'comics') return comic;
  if (show === 'tech') return i.kind === 'tech';
  if (show === 'books') return !comic && i.kind !== 'tech';
  return true;
}

export interface Situation {
  /** Minutes, or null for "any". */
  budget: number | null;
  mode: TimeMode;
  readyToRead: boolean;
  /**
   * Books (not tech), tech books, comics and manga, or everything. The owner asked for these
   * after M3: comics apart from books, and programming books apart from reading for pleasure.
   */
  show?: Show;
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
 * Items without a series, and installments with no number (side stories, specials), are
 * standalone.
 */
export function onePerSeries(items: RankItem[]): RankItem[] {
  const out: RankItem[] = [];
  const bySeries = new Map<string, RankItem[]>();
  for (const i of items) {
    if (!i.series || i.series.position === null) out.push(i);
    else {
      if (!bySeries.has(i.series.key)) bySeries.set(i.series.key, []);
      bySeries.get(i.series.key)!.push(i);
    }
  }
  for (const group of bySeries.values()) {
    const eligible = group.filter((i) => ineligibleBecause(i) === null);
    // Volumes before issues when a series has both (collected editions usually come first).
    const unit = (i: RankItem) => (i.series?.unit === 'issue' ? 1 : 0);
    const pos = (i: RankItem) => i.series?.position ?? Number.POSITIVE_INFINITY;
    const ordered = [...eligible].sort(
      (a, b) => unit(a) - unit(b) || pos(a) - pos(b) || a.title.localeCompare(b.title),
    );
    const next = ordered.find((i) => IN_PROGRESS.includes(i.user.progress)) ?? ordered[0];
    if (next) out.push(next);
  }
  return out;
}

/** Has the owner read or started any other installment of this item's series? */
function seriesStarted(i: RankItem, all: RankItem[]): boolean {
  if (!i.series) return false;
  return seriesMembers(i, all).some(
    (o) =>
      o.id !== i.id &&
      !o.historyOnly &&
      (o.user.progress === 'finished' || IN_PROGRESS.includes(o.user.progress)),
  );
}

/** Every item of each series, indexed once per list (cards look their series up often). */
const seriesIndexCache = new WeakMap<RankItem[], Map<string, RankItem[]>>();
function seriesMembers(i: RankItem, all: RankItem[]): RankItem[] {
  if (!i.series) return [];
  let idx = seriesIndexCache.get(all);
  if (!idx) {
    idx = new Map();
    for (const o of all) {
      if (!o.series) continue;
      if (!idx.has(o.series.key)) idx.set(o.series.key, []);
      idx.get(o.series.key)!.push(o);
    }
    seriesIndexCache.set(all, idx);
  }
  return idx.get(i.series.key) ?? [i];
}

/** What the owner has of an installment, for gaps (§12.5). Null: nothing at all. */
export function holdingOf(i: Pick<RankItem, 'historyOnly' | 'availability'>): Holding | null {
  if (i.historyOnly) return 'read_elsewhere';
  if (i.availability.state === 'missing') return 'unavailable';
  if (i.availability.state === 'none') return null;
  return 'owned';
}

export function asMembers(items: RankItem[]): SeriesMember[] {
  const out: SeriesMember[] = [];
  for (const o of items) {
    const holding = holdingOf(o);
    if (!o.series || !holding) continue;
    out.push({ id: o.id, position: o.series.position, unit: o.series.unit, holding });
  }
  return out;
}

export interface CardGap {
  text: string;
  /** The numbers the owner can mark as read elsewhere. */
  from: number;
  to: number;
  unit: SeriesUnit;
  state: Gap['state'];
}

/** Gaps in this item's series, said from where it sits (§13.4). */
export function gapsForCard(i: RankItem, all: RankItem[]): CardGap[] {
  if (!i.series || i.series.position === null) return [];
  const gaps = seriesGaps(asMembers(seriesMembers(i, all)), i.series.unit);
  return gaps.map((g) => ({ ...g, text: gapSentence(g, i.series!.position) }));
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
  /** The series, for the card's link and gap actions. */
  series: { id: string; name: string } | null;
  /** Gaps in its series (§13.4): shown as text with an icon, before the owner starts. */
  gaps: CardGap[];
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
    const s = i.series;
    const unit = s.unit === 'issue' ? 'issue' : 'vol.';
    const label = s.label ? ` ${unit} ${s.label} ·` : '';
    const story =
      s.status === 'finished'
        ? ' · story finished'
        : s.status === 'ongoing'
          ? ' · story ongoing'
          : '';
    if (seriesStarted(i, all)) return `Next in series ·${label} ${len}${story}`;
    // "vol. 1 · 3 of 12 owned · story ongoing" (§13.3). Read-elsewhere entries aren't owned.
    const owned = ownedCount(asMembers(seriesMembers(i, all)));
    const of = s.total !== null && s.unit === 'volume' ? ` of ${s.total}` : '';
    return `Starts a series ·${label} ${owned}${of} owned · ${len}${story}`;
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
    series: i.series ? { id: i.series.key, name: i.series.name } : null,
    gaps: gapsForCard(i, all),
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

/**
 * Re-orders a ranked list so one author doesn't fill it: each card is ranked by its score less
 * SAME_AUTHOR_PENALTY for every card already placed that shares an author. The score itself is
 * unchanged (it's what the reasons explain); only the order moves.
 */
export function diversify(sorted: Card[]): Card[] {
  const authorsOf = (c: Card) =>
    new Set(c.creators.map((x) => x.name.toLowerCase().replace(/[^\p{L}]+/gu, '')).filter(Boolean));
  const seen = new Map<string, number>();
  const left = [...sorted];
  const out: Card[] = [];
  // Only the top of the list matters to a reader; past that, plain score order is fine and fast.
  const LIMIT = 200;
  while (left.length && out.length < LIMIT) {
    let bestI = 0;
    let bestV = -Infinity;
    for (let i = 0; i < Math.min(left.length, LIMIT); i++) {
      let repeats = 0;
      for (const a of authorsOf(left[i]!)) repeats = Math.max(repeats, seen.get(a) ?? 0);
      const v = left[i]!.score - SAME_AUTHOR_PENALTY * repeats;
      if (v > bestV + 1e-9) {
        bestV = v;
        bestI = i;
      }
    }
    const [c] = left.splice(bestI, 1);
    for (const a of authorsOf(c!)) seen.set(a, (seen.get(a) ?? 0) + 1);
    out.push(c!);
  }
  return [...out, ...left];
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
        shows(i, s.show) &&
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
  main = diversify(main.sort(order));
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
