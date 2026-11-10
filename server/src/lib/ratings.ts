import {
  HIDDEN_GEM_MIN_VOTES,
  HIDDEN_GEM_VOTE_PERCENTILE,
  HIGHLY_RATED_FALLBACK,
  HIGHLY_RATED_MIN_ITEMS,
  HIGHLY_RATED_PERCENTILE,
} from '../config.ts';
import type { SourceName, SourceRating } from '../sources/types.ts';

/**
 * Ratings (PLAN.md §12.2). Pure.
 *
 * - Normalise linearly to 0–100 (4.0 of 5 → 80; AniList is already out of 100).
 * - Shrink toward that source's own mean in this library, in proportion to how few votes
 *   there are (a Bayesian average). Prior weight = the source's median vote count here.
 * - Sources are never pooled: each keeps its own mean and its own "highly rated" line.
 * - Preference where scopes match: Hardcover → AniList → Open Library. A series score is
 *   only ever shown as the series' score.
 */

export interface RatedFrom extends SourceRating {
  source: SourceName;
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

/** Shrinks toward the source's mean: (v·n + mean·m) ÷ (n + m), with m the median vote count. */
export function shrink(r: SourceRating, s: Pick<SourceStats, 'mean' | 'medianVotes'>): number {
  const v = normalise(r);
  const n = r.count ?? 0;
  const m = s.medianVotes;
  if (n + m === 0) return v;
  return (v * n + s.mean * m) / (n + m);
}

/** Per-source statistics over every rating in this library (one per item and source). */
export function ratingStats(all: RatedFrom[]): RatingStats {
  const by = new Map<SourceName, RatedFrom[]>();
  for (const r of all) {
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
      fewVotes: percentile(
        rs.filter((r) => r.count !== null && r.count !== undefined).map((r) => r.count!),
        HIDDEN_GEM_VOTE_PERCENTILE,
      ),
    });
  }
  return out;
}

export interface CommunityRating {
  source: SourceName;
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

/** The community rating to use, by preference, with its scope (§12.2). */
export function communityRating(ratings: RatedFrom[], stats: RatingStats): CommunityRating | null {
  const pick = [...ratings].sort(
    (a, b) => PREFERENCE.indexOf(a.source) - PREFERENCE.indexOf(b.source),
  )[0];
  if (!pick) return null;
  const s = stats.get(pick.source);
  const score = s ? shrink(pick, s) : normalise(pick);
  return {
    source: pick.source,
    raw: pick.value,
    scale: pick.scale,
    votes: pick.count,
    scope: pick.scope,
    score: Math.round(score),
    highlyRated: score >= (s?.highlyRated ?? HIGHLY_RATED_FALLBACK),
    fewVotes:
      pick.count !== null &&
      pick.count !== undefined &&
      pick.count >= HIDDEN_GEM_MIN_VOTES &&
      pick.count <= (s?.fewVotes ?? -1),
  };
}
