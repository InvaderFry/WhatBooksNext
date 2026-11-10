import type { DB } from '../db/database.ts';
import { allMatchInputs, chooseUsed } from '../identify/lookups.ts';
import { seriesKey } from '../identify/series.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import { coveredNumbers, type Coverage } from './series.ts';

/**
 * Collected editions and the issues they hold (PLAN.md §12.5). Coverage is either suggested (a
 * source says so) or confirmed (the owner said so). Only confirmed coverage has effects:
 *  - it fills ownership gaps for its issues (never marks them read);
 *  - finishing the collection makes its covered issues read "via collection";
 *  - reading every covered issue makes the collection read "via issues".
 * The "via" states are derived here and never written to anyone's progress, so every reading
 * is counted once: stats and taste count only what the owner marked.
 */

export interface CoverageRow {
  id: string;
  item_id: string;
  series_id: string;
  first_num: number;
  last_num: number;
  state: 'suggested' | 'confirmed' | 'rejected';
  source: string;
}

/** What the pure rules need to know about an item. */
export interface ViaItem {
  id: string;
  seriesKey: string | null;
  unit: 'volume' | 'issue' | null;
  position: number | null;
  finished: boolean;
}

export type Via = 'collection' | 'issues';

/** Which items count as read through another item (§12.5). Pure. */
export function viaStates(
  items: ViaItem[],
  coverage: (Pick<Coverage, 'itemId' | 'first' | 'last' | 'state'> & { seriesKey: string })[],
): Map<string, Via> {
  const out = new Map<string, Via>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const issuesOf = new Map<string, ViaItem[]>();
  for (const i of items)
    if (i.seriesKey && i.unit === 'issue' && i.position !== null) {
      if (!issuesOf.has(i.seriesKey)) issuesOf.set(i.seriesKey, []);
      issuesOf.get(i.seriesKey)!.push(i);
    }
  const confirmed = coverage.filter((c) => c.state === 'confirmed');

  // Finishing a confirmed collection: its covered issues are read via the collection.
  for (const c of confirmed) {
    if (!byId.get(c.itemId)?.finished) continue;
    for (const i of issuesOf.get(c.seriesKey) ?? [])
      if (!i.finished && i.position! >= c.first && i.position! <= c.last)
        out.set(i.id, 'collection');
  }

  // Reading every covered issue: the collection is read via its issues. Every range of the
  // collection must be read, whole numbers only (a 1.5 is a bonus, not a requirement).
  const byCollection = new Map<string, typeof confirmed>();
  for (const c of confirmed) {
    if (!byCollection.has(c.itemId)) byCollection.set(c.itemId, []);
    byCollection.get(c.itemId)!.push(c);
  }
  for (const [itemId, ranges] of byCollection) {
    const col = byId.get(itemId);
    if (!col || col.finished) continue;
    const all = ranges.every((c) => {
      const read = new Set(
        (issuesOf.get(c.seriesKey) ?? []).filter((i) => i.finished).map((i) => i.position!),
      );
      const nums = coveredNumbers({ first: c.first, last: c.last });
      return nums.length > 0 && nums.every((n) => read.has(n));
    });
    if (all) out.set(itemId, 'issues');
  }
  return out;
}

/** Coverage rows that matter (not rejected), with the collection's title. */
export function loadCoverage(db: DB): (CoverageRow & { title: string })[] {
  return db
    .prepare(
      `SELECT c.*, COALESCE(u.title_override, i.title) AS title FROM collection_coverage c
       JOIN items i ON i.id = c.item_id LEFT JOIN user_item u ON u.item_id = i.id
       WHERE c.state != 'rejected' ORDER BY c.first_num`,
    )
    .all() as (CoverageRow & { title: string })[];
}

function rangeOk(first: unknown, last: unknown): [number, number] {
  const a = Number(first);
  const b = Number(last ?? first);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || b - a > 1000)
    throw new HttpError(
      400,
      'Give issue numbers like 1 and 6 (first ≤ last, at most 1,000 apart).',
    );
  return [a, b];
}

/** The owner says this collection holds issues first–last of a series (confirmed). */
export function addCoverage(
  db: DB,
  itemId: string,
  seriesId: string,
  first: unknown,
  last: unknown,
): string {
  const [a, b] = rangeOk(first, last);
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM series WHERE id = ?').get(seriesId))
      throw new HttpError(404, 'No such series.');
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO collection_coverage (id, item_id, series_id, first_num, last_num, state, source,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'confirmed', 'owner', ?, ?)`,
    ).run(id, itemId, seriesId, a, b, now, now);
    return id;
  })();
}

/** Confirm a suggestion, reject it (never suggested again), or remove the owner's own range. */
export function actOnCoverage(db: DB, id: string, action: 'confirm' | 'reject' | 'remove'): void {
  const row = db.prepare('SELECT * FROM collection_coverage WHERE id = ?').get(id) as
    CoverageRow | undefined;
  if (!row) throw new HttpError(404, 'No such coverage.');
  const now = nowIso();
  if (action === 'confirm')
    db.prepare(
      "UPDATE collection_coverage SET state = 'confirmed', updated_at = ? WHERE id = ?",
    ).run(now, id);
  else if (action === 'reject' || row.source !== 'owner')
    // A source's suggestion is kept as rejected, so the next lookup doesn't suggest it again.
    db.prepare(
      "UPDATE collection_coverage SET state = 'rejected', updated_at = ? WHERE id = ?",
    ).run(now, id);
  else db.prepare('DELETE FROM collection_coverage WHERE id = ?').run(id);
}

/**
 * A source's word on what a collection holds (§12.5), as suggestions: replaces that source's
 * earlier suggestions for the item, and never touches confirmed or rejected rows, nor suggests
 * a range the owner already confirmed or rejected.
 */
export function setSuggestedCoverage(
  db: DB,
  itemId: string,
  source: string,
  ranges: { seriesId: string; first: number; last: number }[],
): void {
  const decided = db
    .prepare(
      `SELECT series_id, first_num, last_num FROM collection_coverage
       WHERE item_id = ? AND state IN ('confirmed', 'rejected')`,
    )
    .all(itemId) as { series_id: string; first_num: number; last_num: number }[];
  db.prepare(
    "DELETE FROM collection_coverage WHERE item_id = ? AND source = ? AND state = 'suggested'",
  ).run(itemId, source);
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO collection_coverage (id, item_id, series_id, first_num, last_num, state, source,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'suggested', ?, ?, ?)`,
  );
  for (const r of ranges) {
    const already = decided.some(
      (d) => d.series_id === r.seriesId && d.first_num === r.first && d.last_num === r.last,
    );
    if (!already) insert.run(newId(), itemId, r.seriesId, r.first, r.last, source, now, now);
  }
}

/**
 * The series a collection's issues belong to, when the owner has any of it. A series nobody owns
 * an issue of has no gaps to fill, so its coverage isn't kept.
 */
export function seriesIdFor(db: DB, key: string, startYear?: number): string | null {
  const runs = db
    .prepare('SELECT id, source_ids FROM series WHERE match_key LIKE ?')
    .all(`${key}|run:%`) as { id: string; source_ids: string }[];
  if (runs.length) {
    // Without a stated run, the name alone cannot choose among known restarts.
    if (startYear === undefined) return null;
    const exact = runs.filter(
      (r) => parseJson<{ runStartYear?: number }>(r.source_ids, {}).runStartYear === startYear,
    );
    return exact.length === 1 ? exact[0]!.id : null;
  }
  return (
    (db.prepare('SELECT id FROM series WHERE match_key = ?').pluck().get(key) as
      string | undefined) ?? null
  );
}

/** Whole numbers into runs: [1,2,3,5,6] → 1–3, 5–6. */
export function toRanges(numbers: number[]): { first: number; last: number }[] {
  const sorted = [...new Set(numbers.filter((n) => Number.isInteger(n) && n >= 0))].sort(
    (a, b) => a - b,
  );
  const out: { first: number; last: number }[] = [];
  for (const n of sorted) {
    const prev = out.at(-1);
    if (prev && prev.last === n - 1) prev.last = n;
    else out.push({ first: n, last: n });
  }
  return out;
}

/**
 * Suggestions from the sources (§12.5): what a collected edition reprints, from the match the
 * app uses for it (accepted or unconfirmed, never a tie). Only issues of a series the owner has
 * something of are kept. Run after each lookup run; owner decisions are never touched.
 */
export function suggestCoverageFromSources(db: DB): number {
  const { matches, rejected, overrides } = allMatchInputs(db);
  const withSuggestions = new Set(
    db
      .prepare("SELECT DISTINCT item_id FROM collection_coverage WHERE source = 'metron'")
      .pluck()
      .all() as string[],
  );
  let suggested = 0;
  for (const [itemId, ms] of matches) {
    const used = chooseUsed(ms, overrides.get(itemId) ?? null, rejected.get(itemId) ?? new Set());
    const rec = used.find((m) => m.source === 'metron' && m.record.collects?.length)?.record;
    if (!rec && !withSuggestions.has(itemId)) continue;
    const bySeries = new Map<string, number[]>();
    for (const c of rec?.collects ?? []) {
      if (!/^\d+$/.test(c.number)) continue;
      const id = seriesIdFor(db, seriesKey('comic', c.series), c.year);
      if (!id) continue;
      if (!bySeries.has(id)) bySeries.set(id, []);
      bySeries.get(id)!.push(Number(c.number));
    }
    const ranges = [...bySeries].flatMap(([seriesId, nums]) =>
      toRanges(nums).map((r) => ({ seriesId, ...r })),
    );
    setSuggestedCoverage(db, itemId, 'metron', ranges);
    suggested += ranges.length;
  }
  return suggested;
}
