import { MATCH_ACCEPT, MATCH_REVIEW } from '../config.ts';
import type { DB } from '../db/database.ts';
import type { RankItem } from './recommend.ts';

/**
 * Match quality (PLAN.md §11.5) and data coverage by kind (§12.1). Measured before ranking is
 * built on it, and shown in Needs review's header.
 *
 * The labelled examples in the app are the owner's own answers: a confirmed match is a correct
 * one, a rejected one was wrong. "Wrong high-confidence matches" counts rejections of a
 * candidate the matching had accepted on its own (score ≥ 0.90) — the number that matters.
 */

export interface MatchReport {
  byBand: {
    accepted: number;
    provisional: number;
    tie: number;
    unidentified: number;
    notLookedUp: number;
  };
  byFormat: Record<string, { items: number; identified: number }>;
  byKind: Record<string, { items: number; identified: number }>;
  labelled: {
    confirmed: number;
    rejected: number;
    wrongHighConfidence: number;
    precision: number | null;
  };
  thresholds: { accept: number; review: number };
}

export function matchReport(db: DB): MatchReport {
  const items = db
    .prepare(
      `SELECT i.id, i.identity, COALESCE(u.kind_override, i.kind, 'unknown') AS kind,
         (SELECT f.format FROM item_files x JOIN files f ON f.id = x.file_id
          WHERE x.item_id = i.id AND x.is_primary = 1) AS format,
         EXISTS (SELECT 1 FROM lookup_state l WHERE l.item_id = i.id) AS looked
       FROM items i LEFT JOIN user_item u ON u.item_id = i.id`,
    )
    .all() as {
    id: string;
    identity: string;
    kind: string;
    format: string | null;
    looked: number;
  }[];
  const byBand = { accepted: 0, provisional: 0, tie: 0, unidentified: 0, notLookedUp: 0 };
  const byFormat: MatchReport['byFormat'] = {};
  const byKind: MatchReport['byKind'] = {};
  for (const i of items) {
    if (!i.looked) byBand.notLookedUp++;
    else byBand[i.identity as keyof typeof byBand]++;
    const ok = i.identity === 'accepted' || i.identity === 'provisional';
    const f = (byFormat[i.format ?? 'none'] ??= { items: 0, identified: 0 });
    f.items++;
    if (ok) f.identified++;
    const k = (byKind[i.kind] ??= { items: 0, identified: 0 });
    k.items++;
    if (ok) k.identified++;
  }
  const confirmed = db
    .prepare(
      "SELECT COUNT(*) FROM user_item WHERE match_override IS NOT NULL AND match_override != 'none'",
    )
    .pluck()
    .get() as number;
  const rejected = db
    .prepare('SELECT COUNT(DISTINCT item_id) FROM candidates_rejected')
    .pluck()
    .get() as number;
  const wrongHighConfidence = db
    .prepare('SELECT COUNT(DISTINCT item_id) FROM candidates_rejected WHERE score >= ?')
    .pluck()
    .get(MATCH_ACCEPT) as number;
  const labelled = confirmed + rejected;
  return {
    byBand,
    byFormat,
    byKind,
    labelled: {
      confirmed,
      rejected,
      wrongHighConfidence,
      precision: labelled ? confirmed / labelled : null,
    },
    thresholds: { accept: MATCH_ACCEPT, review: MATCH_REVIEW },
  };
}

export interface KindCoverage {
  kind: string;
  items: number;
  rated: number;
  lengthKnown: number;
  seriesKnown: number;
}

/** "Novels: 62% rated · Comics: 3% rated" (§12.1), over the backlog-relevant items. */
export function coverageByKind(items: RankItem[]): KindCoverage[] {
  const by = new Map<string, KindCoverage>();
  for (const i of items) {
    if (i.historyOnly) continue;
    const k = i.kind ?? 'unknown';
    const c = by.get(k) ?? { kind: k, items: 0, rated: 0, lengthKnown: 0, seriesKnown: 0 };
    c.items++;
    if (i.community) c.rated++;
    if (i.duration) c.lengthKnown++;
    if (i.series) c.seriesKnown++;
    by.set(k, c);
  }
  return [...by.values()].sort((a, b) => b.items - a.items);
}
