import { publicationView } from './publications.ts';
import type { DB } from '../db/database.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, newId, nowIso } from '../util.ts';
import { historyOnlyIds, loadLibrary, type FolderReachability } from './library.ts';
import { loadCoverage, viaStates } from './coverage.ts';
import { applyUserPatch } from './progress.ts';
import { holdingOf } from './recommend.ts';
import {
  gapSentence,
  missingAfter,
  positionLabel,
  seriesGaps,
  type Coverage,
  type Gap,
  type Holding,
  type SeriesMember,
  type SeriesUnit,
} from './series.ts';

/**
 * One series, as the item page shows it (§12.5, §15): its installments in order, what the owner
 * has of each, the gaps, and whether the story is finished. Also the owner's actions on it.
 */

export interface SeriesEntry {
  id: string;
  title: string;
  position: number | null;
  label: string | null;
  unit: SeriesUnit;
  progress: string;
  holding: Holding | null;
  /** "On external drive (not connected)", "Read elsewhere"… */
  availabilityLabel: string | null;
  formats: string[];
  /** Read through a collection, or (a collection) through every issue it holds. Derived. */
  via?: 'collection' | 'issues' | null;
  /** The owner hid it or marked it Never: never recommended, so never "next" either. */
  hidden?: boolean;
  never?: boolean;
}

export interface SeriesView {
  id: string;
  name: string;
  kind: string | null;
  status: 'finished' | 'ongoing' | 'unknown';
  /** Who said so: a source's name, 'owner', or null when unknown. */
  statusSource: string | null;
  ownerStatus: 'finished' | 'ongoing' | null;
  /** Installments a source says the finished story has. */
  total: number | null;
  publications: ReturnType<typeof publicationView>;
  orderSource: string | null;
  entries: SeriesEntry[];
  gaps: (Gap & { text: string })[];
  /** Collected editions holding this series' issues: confirmed, or suggested by a source. */
  coverage: Coverage[];
  /** Volumes past the last one known, up to the stated total. */
  missingAfter: { from: number; to: number } | null;
  /** Entries with no number: their place in the order is unknown. */
  unnumbered: number;
}

interface SeriesRow {
  id: string;
  name: string;
  kind: string | null;
  publication_status: 'finished' | 'ongoing' | 'unknown';
  installments: number | null;
  order_source: string | null;
  status_source: string | null;
  status_override: 'finished' | 'ongoing' | null;
}

function seriesRow(db: DB, id: string): SeriesRow {
  const s = db
    .prepare(
      `SELECT s.*, u.status_override FROM series s LEFT JOIN series_user u ON u.series_id = s.id
       WHERE s.id = ?`,
    )
    .get(id) as SeriesRow | undefined;
  if (!s) throw new HttpError(404, 'No such series.');
  return s;
}

export function seriesView(db: DB, reach: FolderReachability, id: string): SeriesView {
  const s = seriesRow(db, id);
  const ids = db.prepare('SELECT id FROM items WHERE series_id = ?').pluck().all(id) as string[];
  const places = new Map(
    (
      db
        .prepare('SELECT id, series_position, series_unit FROM items WHERE series_id = ?')
        .all(id) as { id: string; series_position: number | null; series_unit: SeriesUnit | null }[]
    ).map((r) => [r.id, r]),
  );
  const history = historyOnlyIds(db);
  const lib = ids.length ? loadLibrary(db, reach, ids).items : [];
  const unitOrder = (u: SeriesUnit) => (u === 'issue' ? 1 : 0);
  const entries: SeriesEntry[] = lib
    .map((i) => {
      const p = places.get(i.id)!;
      const historyOnly = history.has(i.id);
      const holding = holdingOf({ historyOnly, availability: i.availability, user: i.user });
      return {
        id: i.id,
        title: i.title,
        position: p.series_position,
        label: p.series_position === null ? null : positionLabel(p.series_position),
        unit: p.series_unit ?? 'volume',
        progress: i.user.progress,
        holding,
        availabilityLabel: historyOnly
          ? i.user.progress === 'finished'
            ? 'Read elsewhere'
            : 'History only · not owned'
          : i.availability.label,
        formats: i.formats,
        hidden: i.user.hidden,
        never: i.user.triage === 'never',
      };
    })
    .sort(
      (a, b) =>
        unitOrder(a.unit) - unitOrder(b.unit) ||
        (a.position ?? Infinity) - (b.position ?? Infinity) ||
        a.title.localeCompare(b.title),
    );
  const members: SeriesMember[] = entries
    .filter((e) => e.holding !== null)
    .map((e) => ({ id: e.id, position: e.position, unit: e.unit, holding: e.holding! }));

  // What collected editions hold of this series (§12.5), and what that means for each issue.
  const rows = loadCoverage(db).filter((r) => r.series_id === id);
  const colIds = [...new Set(rows.map((r) => r.item_id))];
  const cols = new Map(
    (colIds.length ? loadLibrary(db, reach, colIds).items : []).map((i) => [i.id, i]),
  );
  const coverage: Coverage[] = rows.map((r) => {
    const col = cols.get(r.item_id);
    const h = col
      ? holdingOf({
          historyOnly: history.has(col.id),
          availability: col.availability,
          user: col.user,
        })
      : null;
    return {
      id: r.id,
      itemId: r.item_id,
      title: col?.title ?? r.title,
      first: r.first_num,
      last: r.last_num,
      state: r.state as Coverage['state'],
      held: h === 'owned' || h === 'read_elsewhere',
    };
  });
  const via = viaStates(
    [
      ...entries.map((e) => ({
        id: e.id,
        seriesKey: id,
        unit: e.unit,
        position: e.position,
        finished: e.progress === 'finished',
      })),
      ...[...cols.values()]
        .filter((c) => !places.has(c.id))
        .map((c) => ({
          id: c.id,
          seriesKey: null,
          unit: null,
          position: null,
          finished: c.user.progress === 'finished',
        })),
    ],
    rows.map((r) => ({
      itemId: r.item_id,
      first: r.first_num,
      last: r.last_num,
      state: r.state as Coverage['state'],
      seriesKey: id,
    })),
  );
  for (const e of entries) e.via = via.get(e.id) ?? null;
  const gaps = (['volume', 'issue'] as const).flatMap((u) =>
    seriesGaps(members, u, coverage).map((g) => ({ ...g, text: gapSentence(g, null) })),
  );
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.publication_status,
    statusSource: s.status_source,
    ownerStatus: s.status_override,
    total: s.installments,
    publications: publicationView(db, id, members),
    orderSource: s.order_source,
    entries,
    gaps,
    coverage,
    missingAfter: missingAfter(members, 'volume', s.installments),
    unnumbered: entries.filter((e) => e.position === null).length,
  };
}

/** The owner says whether the story is finished, or null to go back to what sources say. */
export function setSeriesStatus(db: DB, id: string, status: 'finished' | 'ongoing' | null): void {
  db.transaction(() => {
    seriesRow(db, id);
    if (status === null) db.prepare('DELETE FROM series_user WHERE series_id = ?').run(id);
    else
      db.prepare(
        `INSERT INTO series_user (series_id, status_override, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (series_id) DO UPDATE SET status_override = excluded.status_override,
           updated_at = excluded.updated_at`,
      ).run(id, status, nowIso());
    syncSeries(db);
  })();
}

/** At most this many entries in one "read elsewhere" action: a gap that size is a mistake. */
const MAX_READ_ELSEWHERE = 200;

/**
 * "Mark volume 3 read elsewhere" (§13.4): an entry the owner read but doesn't own. It fills the
 * gap and is never recommended (history-only, §7). Its date is unknown, so it adds no finish to
 * any year (§13.6).
 */
export function markReadElsewhere(
  db: DB,
  seriesId: string,
  unit: SeriesUnit,
  from: number,
  to: number,
): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from)
    throw new HttpError(400, 'from and to must be whole numbers, from ≤ to.');
  if (to - from + 1 > MAX_READ_ELSEWHERE)
    throw new HttpError(400, `Mark at most ${MAX_READ_ELSEWHERE} at a time.`);
  if (unit !== 'volume' && unit !== 'issue')
    throw new HttpError(400, 'unit must be volume or issue.');
  return db.transaction(() => {
    const s = seriesRow(db, seriesId);
    const history = historyOnlyIds(db);
    const taken = new Set(
      db
        .prepare(
          `SELECT i.id, i.series_position, u.progress FROM items i
           LEFT JOIN user_item u ON u.item_id = i.id WHERE i.series_id = ? AND i.series_unit = ?
             AND i.series_position IS NOT NULL`,
        )
        .all(seriesId, unit)
        .filter(
          (r) =>
            !history.has((r as { id: string }).id) ||
            (r as { progress: string }).progress === 'finished',
        )
        .map((r) => (r as { series_position: number }).series_position),
    );
    const now = nowIso();
    const made: string[] = [];
    for (let p = from; p <= to; p++) {
      // Something is already at this number (owned, read elsewhere, or a missing file the
      // owner can fix): leave it alone.
      if (taken.has(p)) continue;
      const id = newId();
      db.prepare(
        `INSERT INTO items (id, kind, kind_source, title, title_source, creators, series_hint, series_id,
           volume_label, issue_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'owner', '[]', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        s.kind,
        s.kind ? 'series' : null,
        unit === 'issue' ? `${s.name} #${p}` : `${s.name} Vol. ${p}`,
        s.name,
        seriesId,
        unit === 'volume' ? String(p) : null,
        unit === 'issue' ? String(p) : null,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO locations (id, item_id, kind, note, created_at, updated_at)
         VALUES (?, ?, 'history', ?, ?, ?)`,
      ).run(newId(), id, 'Marked read elsewhere from a series gap', now, now);
      applyUserPatch(db, id, { progress: 'finished', finishedPrecision: 'unknown' });
      made.push(id);
    }
    syncSeries(db);
    return made;
  })();
}

/**
 * Removes an entry that is only a record of reading elsewhere (no files, no store copy), e.g.
 * a volume marked read elsewhere by mistake. Anything the owner can actually read is refused.
 */
export function removeHistoryEntry(db: DB, itemId: string): void {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM item_files WHERE item_id = ?').get(itemId))
      throw new HttpError(409, 'This book has files; it can’t be removed here.');
    if (db.prepare("SELECT 1 FROM locations WHERE item_id = ? AND kind = 'store'").get(itemId))
      throw new HttpError(409, 'This book is in a store; it can’t be removed here.');
    if (!db.prepare("SELECT 1 FROM locations WHERE item_id = ? AND kind = 'history'").get(itemId))
      throw new HttpError(409, 'Only entries read elsewhere can be removed.');
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
    db.prepare(
      'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
    ).run('item', itemId, nowIso());
    syncSeries(db);
  })();
}

/** One line per series for the Series page (feature review, step 5). */
export interface SeriesSummary {
  id: string;
  name: string;
  kind: string | null;
  /** The owner's answer wins over the sources'. */
  status: 'finished' | 'ongoing' | 'unknown';
  /** Installments the app knows of: owned, read elsewhere, or with missing files. */
  entries: number;
  owned: number;
  /** Finished, or read through a collection. */
  read: number;
  reading: number;
  readElsewhere: number;
  /** Installments neither owned nor read (see missingCount). */
  missing: number;
  /** Owned, but its files are gone. */
  unavailable: number;
  /** The installment to read next: one in progress, else the first unread one owned. */
  next: { id: string; title: string; label: string | null; unit: SeriesUnit } | null;
}

const READING = ['sampled', 'into_it', 'halfway', 'nearly_done'];

/**
 * Installments neither owned nor read, as the series' own view counts them. Volumes: the
 * verified published volumes when a source gave them (they include gaps), else the gaps plus any
 * volumes after the last one up to a stated total. Issues: their gaps. "Maybe in a collection"
 * isn't counted: that waits for the owner's answer.
 */
function missingCount(v: SeriesView): number {
  const gapSize = (unit: SeriesUnit) =>
    v.gaps
      .filter((g) => g.unit === unit && g.state === 'not_owned')
      .reduce((n, g) => n + (g.to - g.from + 1), 0);
  const volumes = v.publications?.volumes.length
    ? v.publications.missing.length
    : gapSize('volume') + (v.missingAfter ? v.missingAfter.to - v.missingAfter.from + 1 : 0);
  return volumes + gapSize('issue');
}

export function seriesSummary(v: SeriesView): SeriesSummary {
  const done = (e: SeriesEntry) => e.progress === 'finished' || !!e.via;
  // Only what What next could offer: owned, not finished or stopped, not hidden or Never.
  const open = v.entries.filter(
    (e) => e.holding === 'owned' && !done(e) && e.progress !== 'dnf' && !e.hidden && !e.never,
  );
  // The same rule as What next's one per series: with volumes and issues, carry on with whichever
  // the owner has been reading; if neither, collected volumes come first.
  const touched = (e: SeriesEntry) => e.progress !== 'not_started' && e.progress !== 'dnf';
  const readingIssues =
    v.entries.some((e) => e.unit === 'issue' && touched(e)) &&
    !v.entries.some((e) => e.unit === 'volume' && touched(e));
  const preferred = open.filter((e) => (e.unit === 'issue') === readingIssues);
  const ordered = [...preferred, ...open.filter((e) => !preferred.includes(e))];
  const next = ordered.find((e) => READING.includes(e.progress)) ?? ordered[0] ?? null;
  return {
    id: v.id,
    name: v.name,
    kind: v.kind,
    status: v.ownerStatus ?? v.status,
    entries: v.entries.length,
    owned: v.entries.filter((e) => e.holding === 'owned').length,
    read: v.entries.filter(done).length,
    reading: v.entries.filter((e) => READING.includes(e.progress)).length,
    readElsewhere: v.entries.filter((e) => e.holding === 'read_elsewhere').length,
    missing: missingCount(v),
    unavailable: v.entries.filter((e) => e.holding === 'unavailable').length,
    next: next && { id: next.id, title: next.title, label: next.label, unit: next.unit },
  };
}

/**
 * Every series, the ones being read first, then started ones, then the rest, each by name. Built
 * from the same seriesView the book page uses, so counts and gaps always agree with it.
 */
export function seriesSummaries(db: DB, reach: FolderReachability): SeriesSummary[] {
  const ids = db
    .prepare('SELECT DISTINCT series_id FROM items WHERE series_id IS NOT NULL')
    .pluck()
    .all() as string[];
  const rank = (s: SeriesSummary) => (s.reading > 0 ? 0 : s.read + s.readElsewhere > 0 ? 1 : 2);
  return ids
    .map((id) => seriesSummary(seriesView(db, reach, id)))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
