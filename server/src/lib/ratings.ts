import {
  HIDDEN_GEM_FEW_FLOOR,
  HIDDEN_GEM_MIN_VOTES,
  HIDDEN_GEM_VOTE_PERCENTILE,
  HIGHLY_RATED_FALLBACK,
  HIGHLY_RATED_MIN_ITEMS,
  HIGHLY_RATED_PERCENTILE,
  RATING_SUPPORTED_VOTES,
} from '../config.ts';
import type { SourceName, SourceRating } from '../sources/types.ts';

/**
 * Ratings (PLAN.md §12.2). Pure.
 *
 * - Normalise linearly to 0–100 (4.0 of 5 → 80; AniList is already out of 100).
 * - Shrink toward that source's own mean in this library, in proportion to how few votes
 *   there are (a Bayesian average). Prior weight = the source's median vote count here.
 * - Sources are never pooled: each keeps its own mean and its own "highly rated" line.
 * - Choose scope and trust first, then the most ratings. A series score stays labelled.
 */

export interface RatedFrom extends SourceRating {
  source: SourceName;
  sourceId: string;
  match:
    | 'confirmed'
    | 'accepted'
    | 'provisional'
    | 'tie'
    | 'rejected'
    | 'unidentified'
    | 'other_candidate'
    | 'left_unidentified';
  strongIsbn: boolean;
  matchScore: number;
  url: string | null;
}

export interface SourceStats {
  mean: number;
  medianVotes: number;
  rated: number;
  /** Shrunk score at or above which a book from this source is "highly rated". */
  highlyRated: number;
  /** Vote counts at or below this are "few" for this source (hidden gems, §20). */
  fewVotes: number;
}

export type RatingStats = Map<SourceName, SourceStats>;

export const PREFERENCE: SourceName[] = ['hardcover', 'anilist', 'openlibrary', 'demo'];

/**
 * A source's own value on its own scale, rounded for reading: whole numbers on 100-point scales,
 * one decimal otherwise ("4.2/5", "9.1/10", "88/100"). Never rescaled or shrunk.
 */
export function displayRaw(raw: number, scale: number): string {
  return `${raw.toFixed(scale >= 100 ? 0 : 1)}/${scale}`;
}

export const normalise = (r: SourceRating): number => (r.value / r.scale) * 100;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Infinity;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

/**
 * The Hidden gems "few votes" line for one source: the bottom part of its known counts here, but
 * never below HIDDEN_GEM_FEW_FLOOR. No known counts: no line (nothing counts as few).
 */
function fewLine(counts: number[], p: number): number {
  if (counts.length === 0) return -1;
  return Math.max(percentile(counts, p), HIDDEN_GEM_FEW_FLOOR);
}

/** Shrinks toward the source's mean: (v·n + mean·m) ÷ (n + m), with m the median vote count. */
export function shrink(r: SourceRating, s: Pick<SourceStats, 'mean' | 'medianVotes'>): number {
  const v = normalise(r);
  const n = r.count ?? 0;
  const m = s.medianVotes;
  if (n + m === 0) return v;
  return (v * n + s.mean * m) / (n + m);
}

/** Per-source statistics over eligible ratings, counting each source record once. */
export function ratingStats(all: RatedFrom[]): RatingStats {
  const by = new Map<SourceName, RatedFrom[]>();
  const seen = new Set<string>();
  for (const r of all) {
    if (!eligibleMatch(r) || !validRating(r)) continue;
    const key = `${r.source}:${r.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!by.has(r.source)) by.set(r.source, []);
    by.get(r.source)!.push(r);
  }
  const out: RatingStats = new Map();
  for (const [source, rs] of by) {
    const mean = rs.reduce((a, r) => a + normalise(r), 0) / rs.length;
    const medianVotes = median(rs.map((r) => r.count ?? 0));
    const base = { mean, medianVotes };
    const shrunk = rs.map((r) => shrink(r, base));
    out.set(source, {
      ...base,
      rated: rs.length,
      highlyRated:
        rs.length < HIGHLY_RATED_MIN_ITEMS
          ? HIGHLY_RATED_FALLBACK
          : percentile(shrunk, HIGHLY_RATED_PERCENTILE),
      // Only real counts: a rating with no count says nothing about obscurity.
      fewVotes: fewLine(
        rs.filter((r) => r.count !== null && r.count !== undefined).map((r) => r.count!),
        HIDDEN_GEM_VOTE_PERCENTILE,
      ),
    });
  }
  return out;
}

export interface CommunityRating {
  source: SourceName;
  sourceId: string;
  match: 'confirmed' | 'accepted' | 'provisional';
  strongIsbn: boolean;
  matchScore: number;
  url: string | null;
  tier: RatingTier;
  reason: RatingReason;
  label: string | null;
  /** Other trusted ratings also have few votes; unknown counts make no claim. */
  fewElsewhere: boolean;
  hiddenGem: boolean;
  /** As the source says it, e.g. 4.2 of 5. */
  raw: number;
  scale: number;
  votes: number | null;
  scope: SourceRating['scope'];
  /** 0–100 after shrinking toward the source's mean. */
  score: number;
  highlyRated: boolean;
  /**
   * Few votes for this source in this library (bottom 25%), and at least 5 (§20). False when the
   * count is unknown: missing data is not obscurity (§13.10).
   */
  fewVotes: boolean;
}

export type RatingTier = 1 | 2 | 3 | 4 | 5;
export type RatingReason =
  | 'more_ratings'
  | 'only_rating'
  | 'series_fallback'
  | 'unconfirmed_only'
  | 'sparse_rating'
  | 'match_tiebreak'
  | 'supported_rating'
  | 'item_scope'
  | 'trusted_match'
  | 'no_rating';
export interface RatingSelection {
  chosen: CommunityRating | null;
  others: RatedFrom[];
  excluded: { rating: RatedFrom; why: string }[];
  reason: RatingReason;
}

type EligibleRating = RatedFrom & { match: CommunityRating['match'] };

const eligibleMatch = (r: RatedFrom): r is EligibleRating =>
  r.match === 'confirmed' || r.match === 'accepted' || r.match === 'provisional';

function validRating(r: RatedFrom): boolean {
  return (
    Number.isFinite(r.value) &&
    Number.isFinite(r.scale) &&
    r.scale > 0 &&
    r.value >= 0 &&
    r.value <= r.scale &&
    (r.count === null || (Number.isInteger(r.count) && r.count >= 0)) &&
    ['book', 'volume', 'series'].includes(r.scope)
  );
}

/** Eligibility shared by selection and source statistics; a tie never supplies a rating. */
export function eligibleRatings(ratings: RatedFrom[], hasSeries: boolean) {
  const eligible: EligibleRating[] = [];
  const excluded: RatingSelection['excluded'] = [];
  for (const r of ratings) {
    if (!eligibleMatch(r)) excluded.push({ rating: r, why: r.match });
    else if (!validRating(r)) excluded.push({ rating: r, why: 'invalid_rating' });
    else if (r.scope === 'series' && !hasSeries) excluded.push({ rating: r, why: 'no_series' });
    else eligible.push(r);
  }
  return { eligible, excluded };
}

/** The first non-empty trust/scope/support tier, then votes, then match evidence (§20). */
export function ratingTier(r: RatedFrom): RatingTier {
  if (r.match === 'provisional') return 5;
  const supported = r.count !== null && r.count >= RATING_SUPPORTED_VOTES;
  return r.scope === 'series' ? (supported ? 2 : 4) : supported ? 1 : 3;
}

function compare(a: RatedFrom, b: RatedFrom): number {
  const preference = (r: RatedFrom) => {
    const n = PREFERENCE.indexOf(r.source);
    return n < 0 ? PREFERENCE.length : n;
  };
  return (
    ratingTier(a) - ratingTier(b) ||
    (b.count ?? -1) - (a.count ?? -1) ||
    Number(b.match === 'confirmed') - Number(a.match === 'confirmed') ||
    Number(b.strongIsbn) - Number(a.strongIsbn) ||
    Number(b.match === 'accepted') - Number(a.match === 'accepted') ||
    b.matchScore - a.matchScore ||
    preference(a) - preference(b) ||
    a.source.localeCompare(b.source) ||
    a.sourceId.localeCompare(b.sourceId)
  );
}

/** One result for every reader: chosen evidence, alternatives, exclusions and explanation. */
export function communityRating(
  ratings: RatedFrom[],
  stats: RatingStats,
  hasSeries = false,
): RatingSelection {
  const { eligible, excluded } = eligibleRatings(ratings, hasSeries);
  const [pick, ...others] = eligible.sort(compare);
  if (!pick) return { chosen: null, others, excluded, reason: 'no_rating' };
  const tier = ratingTier(pick);
  const peer = others.find((r) => ratingTier(r) === tier);
  let reason: RatingReason;
  if (tier === 5) reason = 'unconfirmed_only';
  else if (pick.scope === 'series') reason = 'series_fallback';
  else if (eligible.length === 1) reason = 'only_rating';
  else if (peer) reason = pick.count !== peer.count ? 'more_ratings' : 'match_tiebreak';
  else if (others.every((r) => r.match === 'provisional')) reason = 'trusted_match';
  else if (tier === 1 && others.some((r) => r.scope !== 'series')) reason = 'supported_rating';
  else reason = tier === 3 ? 'sparse_rating' : 'item_scope';
  const s = stats.get(pick.source);
  const score = s ? shrink(pick, s) : normalise(pick);
  const fewVotes =
    pick.count !== null && pick.count >= HIDDEN_GEM_MIN_VOTES && pick.count <= (s?.fewVotes ?? -1);
  const trustedOthers = others.filter((r) => r.match !== 'provisional' && r.count !== null);
  // Every other trusted count is few for its own source: unknown counts make no claim.
  const fewEverywhere = trustedOthers.every(
    (r) => r.count! <= (stats.get(r.source)?.fewVotes ?? -1),
  );
  const fewElsewhere = fewEverywhere && trustedOthers.some((r) => r.source !== pick.source);
  const highlyRated = score >= (s?.highlyRated ?? HIGHLY_RATED_FALLBACK);
  // A gem's quality: its source's own score reaches that source's "highly rated" line, and it
  // is still above the source's average after adjusting for few votes. The adjusted score alone
  // can almost never qualify, because the adjustment pulls few-vote books to the average.
  const gemQuality =
    normalise(pick) >= (s?.highlyRated ?? HIGHLY_RATED_FALLBACK) && score > (s?.mean ?? 100);
  const label =
    tier === 5
      ? 'Unconfirmed match'
      : pick.scope === 'series'
        ? `Whole series; this volume has ${eligible.some((r) => r.match !== 'provisional' && r.scope !== 'series') ? 'few ratings' : 'no rating'}`
        : tier === 3
          ? pick.count === null
            ? 'Number of ratings unknown'
            : 'Few ratings'
          : null;
  return {
    chosen: {
      source: pick.source,
      sourceId: pick.sourceId,
      match: pick.match,
      strongIsbn: pick.strongIsbn,
      matchScore: pick.matchScore,
      url: pick.url,
      tier,
      reason,
      label,
      raw: pick.value,
      scale: pick.scale,
      votes: pick.count,
      scope: pick.scope,
      score: Math.round(score),
      highlyRated,
      fewVotes,
      fewElsewhere,
      hiddenGem:
        gemQuality &&
        fewVotes &&
        pick.scope !== 'series' &&
        pick.match !== 'provisional' &&
        fewEverywhere,
    },
    others,
    excluded,
    reason,
  };
}
