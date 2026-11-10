import {
  HIDDEN_GEM_MIN_VOTES,
  HIDDEN_GEM_VOTE_PERCENTILE,
  HIGHLY_RATED_FALLBACK,
  HIGHLY_RATED_MIN_ITEMS,
  HIGHLY_RATED_PERCENTILE,
} from '../server/src/config.ts';
import { runMode } from '../server/src/lib/modes.ts';
import {
  communityRating,
  eligibleRatings,
  normalise,
  ratingStats,
  ratingTier,
  shrink,
  type CommunityRating,
  type RatedFrom,
  type RatingStats,
} from '../server/src/lib/ratings.ts';
import type { RankItem } from '../server/src/lib/recommend.ts';
import { ratingCases } from '../server/src/testing/ratingCases.ts';
import { situation } from '../server/src/testing/rank.ts';

// Frozen M6 behavior: one sample per item/source, fixed source preference, old gem predicate.
// Kept here for comparison only; application code never calls the old policy.
function oldStats(all: RatedFrom[]): RatingStats {
  const out: RatingStats = new Map();
  const percentile = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)] ?? Infinity;
  for (const source of new Set(all.map((r) => r.source))) {
    const rs = all.filter((r) => r.source === source);
    const counts = rs.map((r) => r.count ?? 0).sort((a, b) => a - b);
    const mid = Math.floor(counts.length / 2);
    const medianVotes = counts.length % 2 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
    const mean = rs.reduce((sum, r) => sum + normalise(r), 0) / rs.length;
    const base = { mean, medianVotes };
    out.set(source, {
      ...base,
      rated: rs.length,
      highlyRated:
        rs.length < HIGHLY_RATED_MIN_ITEMS
          ? HIGHLY_RATED_FALLBACK
          : percentile(
              rs.map((r) => shrink(r, base)),
              HIGHLY_RATED_PERCENTILE,
            ),
      fewVotes: percentile(
        rs.filter((r) => r.count !== null).map((r) => r.count!),
        HIDDEN_GEM_VOTE_PERCENTILE,
      ),
    });
  }
  return out;
}

function oldChoice(rs: RatedFrom[], stats: RatingStats): CommunityRating | null {
  const preference = ['hardcover', 'anilist', 'openlibrary', 'demo'];
  const r = [...rs].sort((a, b) => preference.indexOf(a.source) - preference.indexOf(b.source))[0];
  if (!r) return null;
  const s = stats.get(r.source)!;
  const score = shrink(r, s);
  const highlyRated = score >= s.highlyRated;
  const fewVotes = r.count !== null && r.count >= HIDDEN_GEM_MIN_VOTES && r.count <= s.fewVotes;
  return {
    source: r.source,
    sourceId: r.sourceId,
    match: r.match as CommunityRating['match'],
    strongIsbn: r.strongIsbn,
    matchScore: r.matchScore,
    url: r.url,
    raw: r.value,
    scale: r.scale,
    votes: r.count,
    scope: r.scope,
    score: Math.round(score),
    tier: ratingTier(r),
    reason: 'only_rating',
    label: null,
    highlyRated,
    fewVotes,
    hiddenGem: highlyRated && fewVotes && r.scope !== 'series',
    fewElsewhere: false,
  };
}

export function compareRatings(cases: { item: RankItem; ratings: RatedFrom[] }[]) {
  // M6 used only each source's accepted/provisional/confirmed candidate, excluding series
  // scores on standalone items only after computing source statistics.
  const used = cases.map((c) =>
    c.ratings.filter((r) => ['accepted', 'confirmed', 'provisional'].includes(r.match)),
  );
  const beforeStats = oldStats(used.flat());
  const afterStats = ratingStats(
    cases.flatMap((c) => eligibleRatings(c.ratings, !!c.item.series).eligible),
  );
  const before = cases.map((c, n) => ({
    ...c.item,
    community: oldChoice(
      used[n]!.filter((r) => r.scope !== 'series' || c.item.series),
      beforeStats,
    ),
  }));
  const after = cases.map((c) => ({
    ...c.item,
    community: communityRating(c.ratings, afterStats, !!c.item.series).chosen,
  }));
  let changedSource = 0,
    gained = 0,
    lost = 0,
    movedTier = 0;
  const tierMoves: Record<string, number> = {};
  for (let n = 0; n < cases.length; n++) {
    const a = before[n]!.community,
      b = after[n]!.community;
    if (a && b && a.source !== b.source) changedSource++;
    if (!a && b) gained++;
    if (a && !b) lost++;
    if (a?.tier !== b?.tier) {
      movedTier++;
      const key = `${a?.tier ?? 'unknown'} -> ${b?.tier ?? 'unknown'}`;
      tierMoves[key] = (tierMoves[key] ?? 0) + 1;
    }
  }
  const modes = (['hidden_gems', 'classics', 'waiting'] as const).map((mode) => {
    const opts = { offset: 0, limit: cases.length };
    const ids = (items: RankItem[]) =>
      new Set(runMode(mode, items, situation(), opts).cards.map((c) => c.id));
    const a = ids(before),
      b = ids(after);
    return {
      mode,
      before: a.size,
      after: b.size,
      entering: [...b].filter((id) => !a.has(id)).length,
      leaving: [...a].filter((id) => !b.has(id)).length,
    };
  });
  return {
    items: cases.length,
    changedSource,
    gained,
    lost,
    movedTier,
    tierMoves,
    modes,
    sourceTargets: [...afterStats].map(([source, s]) => ({
      source,
      before: beforeStats.get(source)?.rated ?? 0,
      after: s.rated,
    })),
  };
}

export function reportRatingChanges() {
  const result = compareRatings(ratingCases());
  console.log(
    '\nStage 1 before/after — invented rating fixtures only (title-free; not owner-library counts)',
  );
  console.log(JSON.stringify(result, null, 2));
}
