import type { DB } from '../db/database.ts';
import type { SourceName } from '../sources/types.ts';
import { newId, nowIso } from '../util.ts';
import { titleCompareKey } from './filename.ts';
import { allMatchInputs, chooseUsed } from './lookups.ts';

/**
 * Series as their own rows (PLAN.md §7, §12.5). Rebuilt from what is already stored — the
 * files' own series and numbers, certain online matches, and the owner's corrections — after
 * every scan, lookup run, restore and series correction. No requests, no file reads.
 *
 * A series keeps its id for as long as its key (kind group + normalised name) stays the same,
 * so the owner's corrections to it survive rebuilds.
 *
 * `items.series_id`, `series_position` and `series_unit` are derived here and include the
 * owner's corrections; the corrections themselves live in `user_item` and are never changed.
 */

/** Which source's word on series status and length counts first (§12.2's order). */
const STATUS_PREFERENCE: SourceName[] = ['hardcover', 'anilist', 'demo', 'openlibrary'];

interface ItemRow {
  id: string;
  kind: string | null;
  series_hint: string | null;
  volume_label: string | null;
  issue_label: string | null;
  identity: string;
  series_id: string | null;
  series_position: number | null;
  series_unit: string | null;
  series_override: string | null;
  series_position_override: number | null;
}

interface SeriesRow {
  id: string;
  name: string;
  kind: string | null;
  publication_status: string;
  installments: number | null;
  order_source: string | null;
  status_source: string | null;
  match_key: string | null;
}

interface Placement {
  key: string;
  name: string;
  /** Where the name came from: the owner, the file, or a source. Better names win. */
  nameRank: number;
  position: number | null;
  positionFrom: string | null;
  unit: 'volume' | 'issue';
  kind: string | null;
  source?: {
    source: SourceName;
    status?: 'finished' | 'ongoing' | 'unknown';
    total?: number;
  };
}

const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  // Only a plain number: "Annual 1" or "1a" has no place in the order.
  if (!/^\d+(\.\d+)?$/.test(s.trim())) return null;
  return parseFloat(s);
};

export function seriesKey(kind: string | null, name: string): string {
  return `${kind === 'comic' || kind === 'manga' ? 'c' : 'b'}:${titleCompareKey(name)}`;
}

function placementFor(
  i: ItemRow,
  used: ReturnType<typeof chooseUsed>,
  confirmed: boolean,
): Placement | null {
  if (i.series_override === '') return null;
  // A source's series is used only for a match the app is sure of, or the owner confirmed:
  // a wrong series would invent gaps.
  const trusted =
    confirmed || i.identity === 'accepted' || used.some((m) => m.evidence.isbn === 'strong');
  const rec = (trusted ? used : []).find((m) => m.record.series?.name)?.record;
  let name: string | null = null;
  let nameRank = 0;
  if (i.series_override) [name, nameRank] = [i.series_override, 3];
  else if (i.series_hint) [name, nameRank] = [i.series_hint, 2];
  else if (rec?.series) [name, nameRank] = [rec.series.name, 1];
  if (!name || !titleCompareKey(name)) return null;
  const key = seriesKey(i.kind, name);
  const fromSource = rec?.series && seriesKey(i.kind, rec.series.name) === key ? rec : undefined;

  let position: number | null = null;
  let positionFrom: string | null = null;
  if (i.series_position_override !== null)
    [position, positionFrom] = [i.series_position_override, 'owner'];
  else if (num(i.volume_label) !== null) [position, positionFrom] = [num(i.volume_label), 'file'];
  else if (num(i.issue_label) !== null) [position, positionFrom] = [num(i.issue_label), 'file'];
  else if (fromSource?.series?.position !== undefined)
    [position, positionFrom] = [fromSource.series.position, fromSource.source];

  return {
    key,
    name,
    nameRank,
    position,
    positionFrom,
    // A manga's number is a volume whatever the file calls it (ComicInfo has only "Number").
    unit: i.issue_label && !i.volume_label && i.kind !== 'manga' ? 'issue' : 'volume',
    kind: i.kind,
    source: fromSource?.series
      ? {
          source: fromSource.source,
          status: fromSource.series.status,
          total: fromSource.series.total,
        }
      : undefined,
  };
}

function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts)
    if (c > n) {
      best = v;
      n = c;
    }
  return best;
}

export interface SyncResult {
  series: number;
  itemsChanged: number;
  removed: number;
}

/** Rebuilds series rows and each item's place in them. Idempotent; call inside or outside a transaction. */
export function syncSeries(db: DB): SyncResult {
  return db.transaction(() => doSync(db))();
}

function doSync(db: DB): SyncResult {
  const items = db
    .prepare(
      `SELECT i.id, COALESCE(u.kind_override, i.kind) AS kind, i.series_hint, i.volume_label,
         i.issue_label, i.identity, i.series_id, i.series_position, i.series_unit,
         u.series_override, u.series_position_override
       FROM items i LEFT JOIN user_item u ON u.item_id = i.id`,
    )
    .all() as ItemRow[];
  const { matches, rejected, overrides } = allMatchInputs(db);

  const placements = new Map<string, Placement | null>();
  const groups = new Map<string, { items: ItemRow[]; placements: Placement[] }>();
  for (const i of items) {
    const used = chooseUsed(
      matches.get(i.id) ?? [],
      overrides.get(i.id) ?? null,
      rejected.get(i.id) ?? new Set(),
    );
    const o = overrides.get(i.id);
    const p = placementFor(i, used, Boolean(o && o !== 'none'));
    placements.set(i.id, p);
    if (!p) continue;
    if (!groups.has(p.key)) groups.set(p.key, { items: [], placements: [] });
    groups.get(p.key)!.items.push(i);
    groups.get(p.key)!.placements.push(p);
  }

  const existing = db.prepare('SELECT * FROM series').all() as SeriesRow[];
  const byKey = new Map<string, SeriesRow>();
  for (const s of existing) byKey.set(s.match_key ?? seriesKey(s.kind, s.name), s);
  const ownerStatus = new Map(
    (
      db.prepare('SELECT series_id, status_override FROM series_user').all() as {
        series_id: string;
        status_override: string | null;
      }[]
    ).map((r) => [r.series_id, r.status_override]),
  );

  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO series (id, name, kind, publication_status, installments, source_ids,
       order_source, status_source, match_key, updated_at)
     VALUES (@id, @name, @kind, @publication_status, @installments, '{}', @order_source,
       @status_source, @match_key, @updated_at)`,
  );
  const update = db.prepare(
    `UPDATE series SET name = @name, kind = @kind, publication_status = @publication_status,
       installments = @installments, order_source = @order_source,
       status_source = @status_source, match_key = @match_key, updated_at = @updated_at
     WHERE id = @id`,
  );
  const seriesOf = new Map<string, string>();
  for (const [key, g] of groups) {
    const best = Math.max(...g.placements.map((p) => p.nameRank));
    const name = mostCommon(g.placements.filter((p) => p.nameRank === best).map((p) => p.name))!;
    const kind = mostCommon(g.placements.map((p) => p.kind).filter((k) => k !== null));
    const old = byKey.get(key);
    const id = old?.id ?? newId();
    let status: string = 'unknown';
    let statusSource: string | null = null;
    let installments: number | null = null;
    const owner = ownerStatus.get(id);
    const said = g.placements
      .map((p) => p.source)
      .filter((s) => s && s.status && s.status !== 'unknown')
      .sort(
        (a, b) => STATUS_PREFERENCE.indexOf(a!.source) - STATUS_PREFERENCE.indexOf(b!.source),
      )[0];
    if (owner) [status, statusSource] = [owner, 'owner'];
    else if (said) [status, statusSource] = [said.status!, said.source];
    // A stated length is only trusted for a finished story (a running one keeps growing).
    if (status === 'finished' && said?.status === 'finished' && said.total)
      installments = said.total;
    const froms = g.placements.map((p) => p.positionFrom).filter((x) => x !== null);
    const orderSource = froms.includes('owner')
      ? 'owner'
      : froms.includes('file')
        ? 'file'
        : (mostCommon(froms) ?? null);
    const row: SeriesRow = {
      id,
      name,
      kind,
      publication_status: status,
      installments,
      order_source: orderSource,
      status_source: statusSource,
      match_key: key,
    };
    if (!old) insert.run({ ...row, updated_at: now });
    else if (
      old.name !== row.name ||
      old.kind !== row.kind ||
      old.publication_status !== row.publication_status ||
      old.installments !== row.installments ||
      old.order_source !== row.order_source ||
      old.status_source !== row.status_source ||
      old.match_key !== row.match_key
    )
      update.run({ ...row, updated_at: now });
    seriesOf.set(key, id);
  }

  const setItem = db.prepare(
    'UPDATE items SET series_id = ?, series_position = ?, series_unit = ? WHERE id = ?',
  );
  let itemsChanged = 0;
  for (const i of items) {
    const p = placements.get(i.id) ?? null;
    const sid = p ? seriesOf.get(p.key)! : null;
    const pos = p?.position ?? null;
    const unit = p ? p.unit : null;
    if (i.series_id !== sid || i.series_position !== pos || i.series_unit !== unit) {
      setItem.run(sid, pos, unit, i.id);
      itemsChanged++;
    }
  }

  // Series nothing belongs to any more go, unless the owner corrected them or said a collection
  // covers them. (Suggested coverage of a series that goes, goes with it.)
  const orphans = db
    .prepare(
      `SELECT id FROM series s WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.series_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM series_user x WHERE x.series_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM collection_coverage c WHERE c.series_id = s.id
           AND c.state != 'suggested')`,
    )
    .pluck()
    .all() as string[];
  for (const id of orphans) {
    db.prepare('DELETE FROM series WHERE id = ?').run(id);
    db.prepare(
      'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
    ).run('series', id, now);
  }
  return { series: groups.size, itemsChanged, removed: orphans.length };
}
