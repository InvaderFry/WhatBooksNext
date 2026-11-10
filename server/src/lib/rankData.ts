import { BULK_COPY_SHARE } from '../config.ts';
import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { allMatchInputs, chooseUsed, picturesFile, type MatchRow } from '../identify/lookups.ts';
import { SOURCE_LABELS } from '../sources/types.ts';
import { todayLocal } from '../util.ts';
import { estimateDuration, estimateEffort, unitFor } from './estimate.ts';
import { loadLibrary, type FolderReachability, type ItemSummary } from './library.ts';
import { communityRating, ratingStats, type RatedFrom, type RatingStats } from './ratings.ts';
import type { RankItem } from './recommend.ts';

/**
 * Assembles what the pure ranking needs (§6.4) from the database, in a handful of bulk
 * queries: the library, each item's primary-file counts, the matches in use, and the
 * per-source rating statistics. A few thousand items take tens of milliseconds.
 */

interface ItemFactRow {
  id: string;
  series_hint: string | null;
  volume_label: string | null;
  issue_label: string | null;
  publication_year: number | null;
  identity: RankItem['identity'];
  match_source: string | null;
  acquired_on: string | null;
  words: number | null;
  pages: number | null;
  pdf_type: string | null;
  pdf_override: string | null;
  format: string | null;
  size: number | null;
  /** The largest page count among the item's files (another copy may have one). */
  any_pages: number | null;
}

export interface RankData {
  items: RankItem[];
  stats: RatingStats;
  /** Everything the library view has, by id (for detail views). */
  library: Map<string, ItemSummary>;
  used: Map<string, MatchRow[]>;
}

const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** Library folders where most files share one day's date: a bulk copy, dates unknown (§13.7). */
function bulkCopyFolders(db: DB): Set<string> {
  const rows = db
    .prepare(
      `SELECT folder_id, date(MIN(COALESCE(created_ms, modified_ms), COALESCE(modified_ms, created_ms)) / 1000, 'unixepoch', 'localtime') AS day,
         COUNT(*) AS n
       FROM files WHERE excluded = 0 AND (created_ms IS NOT NULL OR modified_ms IS NOT NULL)
       GROUP BY folder_id, day`,
    )
    .all() as { folder_id: string; day: string; n: number }[];
  const totals = new Map<string, number>();
  const top = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.folder_id, (totals.get(r.folder_id) ?? 0) + r.n);
    top.set(r.folder_id, Math.max(top.get(r.folder_id) ?? 0, r.n));
  }
  const out = new Set<string>();
  for (const [f, t] of totals) if ((top.get(f) ?? 0) / t > BULK_COPY_SHARE) out.add(f);
  return out;
}

export function loadRankData(db: DB, reach: FolderReachability): RankData {
  const { items, folders } = loadLibrary(db, reach);
  const facts = new Map(
    (
      db
        .prepare(
          `SELECT i.id, i.series_hint, i.volume_label, i.issue_label, i.publication_year, i.identity,
             i.match_source, u.acquired_on, f.word_count AS words, f.page_count AS pages,
             f.pdf_type, fu.pdf_type_override AS pdf_override, f.format, f.size,
             (SELECT MAX(g.page_count) FROM item_files y JOIN files g ON g.id = y.file_id
              WHERE y.item_id = i.id) AS any_pages
           FROM items i
           LEFT JOIN user_item u ON u.item_id = i.id
           LEFT JOIN item_files x ON x.item_id = i.id AND x.is_primary = 1
           LEFT JOIN files f ON f.id = x.file_id
           LEFT JOIN file_user fu ON fu.file_id = f.id`,
        )
        .all() as ItemFactRow[]
    ).map((r) => [r.id, r]),
  );
  const fileDates = new Map<string, { ms: number; folderId: string }[]>();
  for (const r of db
    .prepare(
      `SELECT x.item_id, f.folder_id, MIN(COALESCE(f.created_ms, f.modified_ms), COALESCE(f.modified_ms, f.created_ms)) AS ms
       FROM item_files x JOIN files f ON f.id = x.file_id WHERE ms IS NOT NULL`,
    )
    .all() as { item_id: string; folder_id: string; ms: number }[]) {
    if (!fileDates.has(r.item_id)) fileDates.set(r.item_id, []);
    fileDates.get(r.item_id)!.push({ ms: r.ms, folderId: r.folder_id });
  }
  const historyOnly = new Set(
    db
      .prepare(
        `SELECT DISTINCT l.item_id FROM locations l WHERE l.kind = 'history'
         AND NOT EXISTS (SELECT 1 FROM item_files x WHERE x.item_id = l.item_id)
         AND NOT EXISTS (SELECT 1 FROM locations s WHERE s.item_id = l.item_id AND s.kind = 'store')`,
      )
      .pluck()
      .all() as string[],
  );
  const bulk = bulkCopyFolders(db);

  const { matches, rejected, overrides } = allMatchInputs(db);
  const used = new Map<string, MatchRow[]>();
  const allRatings: RatedFrom[] = [];
  for (const i of items) {
    const u = chooseUsed(
      matches.get(i.id) ?? [],
      overrides.get(i.id) ?? null,
      rejected.get(i.id) ?? new Set(),
    );
    used.set(i.id, u);
    for (const m of u)
      if (m.record.rating) allRatings.push({ ...m.record.rating, source: m.source });
  }
  const stats = ratingStats(allRatings);

  const rankItems: RankItem[] = items.map((i) => {
    const f = facts.get(i.id);
    const u = used.get(i.id) ?? [];
    const override = overrides.get(i.id);
    const ratings = u
      .filter((m) => m.record.rating)
      .map((m) => ({ ...m.record.rating!, source: m.source }));
    // A series rating is only used for an item that is part of a series (§12.2).
    const seriesName =
      f?.series_hint ?? u.find((m) => m.record.series?.name)?.record.series?.name ?? null;
    const usable = ratings.filter((r) => r.scope !== 'series' || seriesName);
    const pdfType = f?.pdf_override ?? f?.pdf_type ?? null;
    const sourcePages = u.find((m) => m.record.pages)?.record;
    const label = f?.volume_label ?? f?.issue_label ?? null;
    const position =
      num(f?.volume_label) ??
      num(f?.issue_label) ??
      u.find((m) => m.record.series?.position)?.record.series?.position ??
      null;
    const dates = fileDates.get(i.id) ?? [];
    const realDates = dates.filter((d) => !bulk.has(d.folderId));
    let acquired: RankItem['acquired'];
    if (f?.acquired_on) acquired = { date: f.acquired_on, basis: 'entered' };
    else if (realDates.length)
      acquired = {
        date: todayLocal(new Date(Math.min(...realDates.map((d) => d.ms)))),
        basis: 'file_date',
      };
    else if (dates.length === 0 && i.firstSeenAt && !firstScan(i, folders))
      acquired = { date: i.firstSeenAt.slice(0, 10), basis: 'first_seen' };
    else acquired = { date: null, basis: 'unknown' };

    return {
      id: i.id,
      title: i.title,
      kind: i.kind,
      isReference: i.isReference,
      creators: i.creators,
      coverFileId: i.coverFileId,
      formats: i.formats,
      availability: i.availability,
      user: i.user,
      identity: f?.identity ?? 'unidentified',
      matchConfirmed:
        Boolean(override && override !== 'none') || u.some((m) => m.evidence.isbn === 'strong'),
      historyOnly: historyOnly.has(i.id),
      series: seriesName
        ? {
            key: `${i.kind === 'manga' || i.kind === 'comic' ? 'c' : 'b'}:${titleCompareKey(seriesName)}`,
            name: seriesName,
            position,
            label,
          }
        : null,
      duration: estimateDuration(
        {
          kind: i.kind,
          // An image-only EPUB's few words aren't a length; its pages may be on another copy.
          words:
            f &&
            picturesFile({
              format: f.format ?? '',
              word_count: f.words,
              page_count: f.pages,
              size: f.size ?? 0,
            }) &&
            f.format === 'epub'
              ? null
              : (f?.words ?? null),
          // A PDF's page count is measured; its words exist only with a text layer.
          pages: f?.pages ?? f?.any_pages ?? null,
          pdfType,
          sourcePages: sourcePages?.pages ?? null,
          sourceName: sourcePages ? SOURCE_LABELS[sourcePages.source] : null,
        },
        unitFor(i.kind, f?.volume_label ?? null, f?.issue_label ?? null),
      ),
      community: communityRating(usable, stats),
      firstPublishYear: f?.publication_year ?? null,
      acquired,
      effort: i.user.effortOverride ?? estimateEffort(i.kind, i.isReference),
    };
  });
  return { items: rankItems, stats, library: new Map(items.map((i) => [i.id, i])), used };
}

/** Was the item first seen in its folder's first scan? Then first-seen isn't an acquisition. */
function firstScan(i: ItemSummary, folders: Map<string, { created_at: string }>): boolean {
  const created = i.folderIds.map((f) => folders.get(f)?.created_at).filter(Boolean) as string[];
  if (created.length === 0) return true;
  const earliest = created.sort()[0]!;
  return Date.parse(i.firstSeenAt) - Date.parse(earliest) < 86_400_000;
}
