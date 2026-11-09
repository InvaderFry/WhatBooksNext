import { REVIEW_DEFER_DAYS } from '../config.ts';
import type { DB } from '../db/database.ts';
import {
  applyIdentity,
  decisionsFor,
  matchesOf,
  matchFactsFor,
  storeCandidates,
  type MatchRow,
} from '../identify/lookups.ts';
import { rankCandidates, scoreCandidate } from '../identify/match.ts';
import { SOURCE_LABELS, type SourceName, type SourceRecord } from '../sources/types.ts';
import { HttpError, nowIso } from '../util.ts';
import { ensureUserRow } from './progress.ts';

/**
 * Needs review for identities (PLAN.md §11.4), tiers 2–4, and the owner's match decisions:
 * Confirm, Not this one, Leave unidentified, Search and pick, Defer and Dismiss. These rows are
 * computed from the items' current state, so a later lookup that settles a question removes
 * its row. The owner's decisions are owner data (user_item, candidates_rejected) and always win.
 */

export interface CandidateView {
  source: SourceName;
  sourceLabel: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  year: number | null;
  score: number;
  notes: string[];
  url: string | null;
  rating: string | null;
}

export function candidateView(m: Pick<MatchRow, 'record' | 'score' | 'evidence'>): CandidateView {
  const r = m.record;
  return {
    source: r.source,
    sourceLabel: SOURCE_LABELS[r.source],
    sourceId: r.sourceId,
    title: r.title,
    subtitle: r.subtitle ?? null,
    authors: r.authors.slice(0, 4),
    year: r.firstPublishYear ?? null,
    score: m.score,
    notes: m.evidence.notes,
    // Only http(s) links are ever shown (text from sources is untrusted, §6.3).
    url: r.url && /^https:\/\//.test(r.url) ? r.url : null,
    rating: r.rating
      ? `${r.rating.scale === 100 ? Math.round(r.rating.value) : r.rating.value.toFixed(1)}/${r.rating.scale}${r.rating.count ? ` (${r.rating.count.toLocaleString('en-US')} ratings)` : ''}${r.rating.scope === 'series' ? ', whole series' : ''}`
      : null,
  };
}

export interface IdentityRow {
  id: string;
  kind: 'tie' | 'wrong_match' | 'unidentified' | 'provisional';
  tier: 2 | 3 | 4;
  why: string;
  itemId: string;
  title: string;
  hasHistory: boolean;
  candidates: CandidateView[];
}

interface ItemStateRow {
  id: string;
  title: string;
  identity: string;
  identity_score: number | null;
  kind: string | null;
  match_override: string | null;
  wrong_match_at: string | null;
  progress: string | null;
  shortlist_position: number | null;
  triage: string | null;
  rating: number | null;
}

/** Rows hidden by Defer (until their date) or Dismiss. */
export function hiddenReviewKeys(db: DB): Set<string> {
  const now = nowIso();
  return new Set(
    (
      db.prepare('SELECT key, state, until FROM review_state').all() as {
        key: string;
        state: string;
        until: string | null;
      }[]
    )
      .filter((r) => r.state === 'dismissed' || (r.until !== null && r.until > now))
      .map((r) => r.key),
  );
}

const IN_PROGRESS = ['sampled', 'into_it', 'halfway', 'nearly_done'];

/**
 * Identity rows. Tier 2: ties and "Wrong book". Tier 3: unidentified or unconfirmed items that
 * matter now (shortlisted or in progress). Tier 4: other unconfirmed matches; plain
 * unidentified items are only counted there, because a big library has thousands.
 */
export function identityRows(db: DB): { rows: IdentityRow[]; unidentifiedOther: number } {
  const items = db
    .prepare(
      `SELECT i.id, COALESCE(u.title_override, i.title) AS title, i.identity, i.identity_score,
         COALESCE(u.kind_override, i.kind) AS kind, u.match_override, u.wrong_match_at,
         u.progress, u.shortlist_position, u.triage, u.rating
       FROM items i LEFT JOIN user_item u ON u.item_id = i.id
       WHERE (u.match_override IS NULL OR u.wrong_match_at IS NOT NULL)
         AND (i.identity != 'accepted' OR u.wrong_match_at IS NOT NULL)
         AND COALESCE(u.hidden, 0) = 0
         AND EXISTS (SELECT 1 FROM lookup_state l WHERE l.item_id = i.id AND l.outcome != 'failed')
       ORDER BY title`,
    )
    .all() as ItemStateRow[];
  const rejected = db.prepare(
    'SELECT source, source_id FROM candidates_rejected WHERE item_id = ?',
  );
  const rows: IdentityRow[] = [];
  let unidentifiedOther = 0;
  for (const i of items) {
    const matters = i.shortlist_position !== null || IN_PROGRESS.includes(i.progress ?? '');
    const hasHistory =
      i.progress !== null &&
      (i.progress !== 'not_started' || i.rating !== null || i.triage !== null);
    const rej = new Set(
      (rejected.all(i.id) as { source: string; source_id: string }[]).map(
        (r) => `${r.source}:${r.source_id}`,
      ),
    );
    const matches = matchesOf(db, i.id).filter((m) => !rej.has(`${m.source}:${m.sourceId}`));
    const candidates = rankCandidates(matches)
      .slice(0, 4)
      .map((m) => candidateView(m as MatchRow));
    const base = { itemId: i.id, title: i.title, hasHistory, candidates };
    if (i.wrong_match_at) {
      rows.push({
        ...base,
        id: `identity:${i.id}`,
        kind: 'wrong_match',
        tier: 2,
        why: 'You said a recommendation showed the wrong book. Pick the right match, or leave it unidentified.',
      });
    } else if (i.identity === 'tie') {
      rows.push({
        ...base,
        id: `identity:${i.id}`,
        kind: 'tie',
        tier: 2,
        why: 'Two different books match about equally well, so neither was used. Which is it?',
      });
    } else if (i.identity === 'unidentified') {
      if (matters)
        rows.push({
          ...base,
          id: `identity:${i.id}`,
          kind: 'unidentified',
          tier: 3,
          why: 'No online match was close enough. It’s on your shortlist or in progress, so a match would help its recommendations.',
        });
      else unidentifiedOther++;
    } else if (i.identity === 'provisional') {
      rows.push({
        ...base,
        id: `identity:${i.id}`,
        kind: 'provisional',
        tier: matters ? 3 : 4,
        why: `Probably this match (score ${Math.round((i.identity_score ?? 0) * 100)}), but not certain. It’s used, marked “unconfirmed”.`,
      });
    }
  }
  return { rows, unidentifiedOther };
}

// ---- Owner decisions -------------------------------------------------------------------------

/** Search results held between "Search" and "Pick", so a pick can't name a record we never saw. */
const searched = new Map<string, SourceRecord[]>();

export function rememberSearch(itemId: string, records: SourceRecord[]): void {
  searched.set(itemId, records);
  // A small, bounded memory: only the latest few searches are kept.
  if (searched.size > 50) searched.delete(searched.keys().next().value!);
}

export function scoreSearchResults(
  db: DB,
  itemId: string,
  records: SourceRecord[],
): CandidateView[] {
  const facts = matchFactsFor(db, itemId);
  if (!facts) throw new HttpError(404, 'No such item.');
  return rankCandidates(records.map((r) => scoreCandidate(facts, r))).map(candidateView);
}

export type MatchAction =
  | { action: 'confirm'; source: SourceName; sourceId: string }
  | { action: 'reject'; source: SourceName; sourceId: string }
  | { action: 'none' }
  | { action: 'reset' };

export function validateMatchAction(body: unknown): MatchAction {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.action === 'none' || b.action === 'reset') return { action: b.action };
  if (
    (b.action === 'confirm' || b.action === 'reject') &&
    typeof b.source === 'string' &&
    typeof b.sourceId === 'string' &&
    b.source in SOURCE_LABELS
  )
    return { action: b.action, source: b.source as SourceName, sourceId: b.sourceId };
  throw new HttpError(
    400,
    'action must be confirm or reject (with source and sourceId), none or reset.',
  );
}

export function applyMatchAction(db: DB, itemId: string, a: MatchAction): void {
  ensureUserRow(db, itemId);
  const now = nowIso();
  const setOverride = (v: string | null) =>
    db
      .prepare(
        'UPDATE user_item SET match_override = ?, wrong_match_at = NULL, updated_at = ? WHERE item_id = ?',
      )
      .run(v, now, itemId);
  if (a.action === 'confirm') {
    const key = `${a.source}:${a.sourceId}`;
    const known = matchesOf(db, itemId).some((m) => `${m.source}:${m.sourceId}` === key);
    if (!known) {
      // Picked from a search: keep that record as a candidate, so its data can be used.
      const rec = searched
        .get(itemId)
        ?.find((r) => r.source === a.source && r.sourceId === a.sourceId);
      if (!rec) throw new HttpError(409, 'Search again, then pick.');
      const facts = matchFactsFor(db, itemId)!;
      const others = matchesOf(db, itemId)
        .filter((m) => m.source === a.source)
        .map((m) => ({ record: m.record, score: m.score, evidence: m.evidence }));
      storeCandidates(
        db,
        itemId,
        a.source,
        rankCandidates([scoreCandidate(facts, rec), ...others]).slice(0, 5),
      );
      // storeCandidates keeps the top five; make sure the pick survived.
      if (!matchesOf(db, itemId).some((m) => `${m.source}:${m.sourceId}` === key))
        storeCandidates(db, itemId, a.source, [scoreCandidate(facts, rec)]);
    }
    db.prepare(
      'DELETE FROM candidates_rejected WHERE item_id = ? AND source = ? AND source_id = ?',
    ).run(itemId, a.source, a.sourceId);
    setOverride(key);
  } else if (a.action === 'reject') {
    const score = db
      .prepare('SELECT score FROM item_matches WHERE item_id = ? AND source = ? AND source_id = ?')
      .pluck()
      .get(itemId, a.source, a.sourceId) as number | undefined;
    db.prepare(
      'INSERT OR IGNORE INTO candidates_rejected (item_id, source, source_id, score, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(itemId, a.source, a.sourceId, score ?? null, now);
    const cur = db
      .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
      .pluck()
      .get(itemId);
    if (cur === `${a.source}:${a.sourceId}`) setOverride(null);
    else
      db.prepare(
        'UPDATE user_item SET wrong_match_at = NULL, updated_at = ? WHERE item_id = ?',
      ).run(now, itemId);
  } else if (a.action === 'none') {
    setOverride('none');
  } else {
    setOverride(null);
  }
  applyIdentity(db, itemId);
}

/** The decision each source made, for the item page. */
export function itemMatchSummary(db: DB, itemId: string) {
  const rej = new Set(
    (
      db
        .prepare('SELECT source, source_id FROM candidates_rejected WHERE item_id = ?')
        .all(itemId) as {
        source: string;
        source_id: string;
      }[]
    ).map((r) => `${r.source}:${r.source_id}`),
  );
  const matches = matchesOf(db, itemId);
  const decisions = decisionsFor(matches, rej);
  const override = db
    .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId) as string | null | undefined;
  const lookups = db
    .prepare('SELECT source, outcome, looked_up_at, error FROM lookup_state WHERE item_id = ?')
    .all(itemId) as {
    source: SourceName;
    outcome: string;
    looked_up_at: string;
    error: string | null;
  }[];
  return {
    override: override ?? null,
    lookups: lookups.map((l) => ({ ...l, sourceLabel: SOURCE_LABELS[l.source] })),
    sources: [...decisions.entries()].map(([source, d]) => ({
      source,
      sourceLabel: SOURCE_LABELS[source],
      decision: d.decision,
      chosen: d.best ? candidateView(d.best) : null,
    })),
    candidates: rankCandidates(matches.filter((m) => !rej.has(`${m.source}:${m.sourceId}`)))
      .slice(0, 6)
      .map((m) => candidateView(m as MatchRow)),
  };
}

// ---- Defer and Dismiss ---------------------------------------------------------------------------

export function setReviewState(
  db: DB,
  key: string,
  state: 'deferred' | 'dismissed' | null,
  until?: string,
): void {
  if (state === null) {
    db.prepare('DELETE FROM review_state WHERE key = ?').run(key);
    return;
  }
  const u =
    state === 'deferred'
      ? (until ?? new Date(Date.now() + REVIEW_DEFER_DAYS * 86_400_000).toISOString())
      : null;
  db.prepare(
    `INSERT INTO review_state (key, state, until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET state = excluded.state, until = excluded.until,
       updated_at = excluded.updated_at`,
  ).run(key, state, u, nowIso());
}
