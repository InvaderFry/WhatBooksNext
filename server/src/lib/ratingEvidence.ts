import { decisionsFor, type MatchRow } from '../identify/lookups.ts';
import type { RatedFrom } from './ratings.ts';

/** Translate each stored candidate's own decision and ISBN evidence without changing matches. */
export function ratingEvidence(
  matches: MatchRow[],
  override: string | null,
  rejected: Set<string>,
): RatedFrom[] {
  const decisions = decisionsFor(matches, rejected);
  return matches.flatMap((m): RatedFrom[] => {
    if (!m.record.rating) return [];
    const key = `${m.source}:${m.sourceId}`;
    const d = decisions.get(m.source);
    const match: RatedFrom['match'] =
      override === 'none'
        ? 'left_unidentified'
        : rejected.has(key)
          ? 'rejected'
          : override === key
            ? 'confirmed'
            : override?.startsWith(`${m.source}:`)
              ? 'other_candidate'
              : d?.decision === 'tie'
                ? 'tie'
                : d?.best === m
                  ? d.decision
                  : d?.best
                    ? 'other_candidate'
                    : 'unidentified';
    return [
      {
        ...m.record.rating,
        count: m.record.rating.count ?? null,
        source: m.source,
        sourceId: m.sourceId,
        match,
        strongIsbn: m.evidence.isbn === 'strong',
        matchScore: m.score,
        url: m.record.url ?? null,
      },
    ];
  });
}
