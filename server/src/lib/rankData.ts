import { BULK_COPY_SHARE } from '../config.ts';
import type { DB } from '../db/database.ts';
import { allMatchInputs, chooseUsed, picturesFile, type MatchRow } from '../identify/lookups.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';
import { parseJson, todayLocal } from '../util.ts';
import { estimateDuration, estimateEffort, unitFor } from './estimate.ts';
import {
  historyOnlyIds,
  loadLibrary,
  type FolderReachability,
  type ItemSummary,
} from './library.ts';
import {
  communityRating,
  eligibleRatings,
  ratingStats,
  type RatedFrom,
  type RatingStats,
  type RatingSelection,
} from './ratings.ts';
import { ratingEvidence } from './ratingEvidence.ts';
import type { ItemDetails } from './details.ts';
import { holdingOf, type RankItem } from './recommend.ts';
import { loadCoverage, viaStates } from './coverage.ts';
import { positionLabel, type Coverage } from './series.ts';

/**
 * Assembles what the pure ranking needs (§6.4) from the database, in a handful of bulk
 * queries: the library, each item's primary-file counts, the matches in use, and the
 * per-source rating statistics. A few thousand items take tens of milliseconds.
 */

interface ItemFactRow {
  id: string;
  series_id: string | null;
  series_position: number | null;
  series_unit: 'volume' | 'issue' | null;
  series_name: string | null;
  series_status: 'finished' | 'ongoing' | 'unknown' | null;
  series_total: number | null;
  series_hint: string | null;
  volume_label: string | null;
  issue_label: string | null;
  publication_year: number | null;
  identity: RankItem['identity'];
  match_source: string | null;
  match_source_id: string | null;
  acquired_on: string | null;
  words: number | null;
  pages: number | null;
  pdf_type: string | null;
  pdf_override: string | null;
  format: string | null;
  size: number | null;
  /** The largest page count among the item's files (another copy may have one). */
  any_pages: number | null;
  /** The primary file's embedded metadata (JSON): subjects, publisher, ComicInfo genre. */
  metadata: string | null;
}

export interface RankData {
  items: RankItem[];
  stats: RatingStats;
  details: Map<string, ItemDetails>;
  ratings: Map<string, RatingSelection>;
  /** Everything the library view has, by id (for detail views). */
  library: Map<string, ItemSummary>;
  used: Map<string, MatchRow[]>;
  /**
   * Items that arrived after their folder's first scan, with when they were first seen: genuinely
   * new, not a new format of a known book (which joins the known item) (§13.5).
   */
  arrivals: Map<string, string>;
}

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
  const { items, folders, details, rankingFacts } = loadLibrary(db, reach);
  const facts = new Map(
    (
      db
        .prepare(
          `SELECT i.id, i.series_id, i.series_position, i.series_unit, s.name AS series_name,
             s.publication_status AS series_status, s.installments AS series_total,
             i.series_hint, i.volume_label, i.issue_label, i.publication_year, i.identity,
             i.match_source, i.match_source_id, u.acquired_on, f.word_count AS words, f.page_count AS pages,
             f.pdf_type, fu.pdf_type_override AS pdf_override, f.format, f.size, f.metadata,
             (SELECT MAX(g.page_count) FROM item_files y JOIN files g ON g.id = y.file_id
              WHERE y.item_id = i.id) AS any_pages
           FROM items i
           LEFT JOIN series s ON s.id = i.series_id
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
  const historyOnly = historyOnlyIds(db);
  const bulk = bulkCopyFolders(db);

  const { matches, rejected, overrides } = allMatchInputs(db);
  const used = new Map<string, MatchRow[]>();
  const allRatings: RatedFrom[] = [];
  const evidence = new Map<string, RatedFrom[]>();
  const ratings = new Map<string, RatingSelection>();
  for (const i of items) {
    const u = chooseUsed(
      matches.get(i.id) ?? [],
      overrides.get(i.id) ?? null,
      rejected.get(i.id) ?? new Set(),
    );
    used.set(i.id, u);
    const rs = ratingEvidence(
      matches.get(i.id) ?? [],
      overrides.get(i.id) ?? null,
      rejected.get(i.id) ?? new Set(),
    );
    evidence.set(i.id, rs);
    allRatings.push(...eligibleRatings(rs, !!facts.get(i.id)?.series_id).eligible);
  }
  const stats = ratingStats(allRatings);

  const rankItems: RankItem[] = items.map((i) => {
    const f = facts.get(i.id);
    const u = used.get(i.id) ?? [];
    const override = overrides.get(i.id);
    const selection = communityRating(evidence.get(i.id) ?? [], stats, !!f?.series_id);
    ratings.set(i.id, selection);
    const pdfType = f?.pdf_override ?? f?.pdf_type ?? null;
    const chosenDetails = details.get(i.id)!;
    const sourcePages = chosenDetails.pages?.measured ? null : chosenDetails.pages;
    const ranking = rankingFacts.get(i.id)!;
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

    const md = parseJson<EmbeddedMetadata | null>(f?.metadata ?? null, null);
    const subjects = [
      ...new Set([
        ...u.flatMap((m) => m.record.subjects),
        ...(md?.subjects ?? []),
        ...(md?.comic?.genre ? [md.comic.genre] : []),
      ]),
    ];

    return {
      id: i.id,
      title: ranking.title,
      displayTitle: i.title,
      displayCreators: i.creators,
      kind: i.kind,
      isReference: i.isReference,
      subjects,
      publisher: md?.comic?.publisher ?? md?.publisher ?? null,
      creators: ranking.creators,
      coverFileId: i.coverFileId,
      formats: i.formats,
      availability: i.availability,
      user: i.user,
      identity: f?.identity ?? 'unidentified',
      matchConfirmed:
        Boolean(override && override !== 'none') || u.some((m) => m.evidence.isbn === 'strong'),
      historyOnly: historyOnly.has(i.id),
      work:
        f?.match_source &&
        f.match_source_id &&
        (f.identity === 'accepted' || f.identity === 'provisional')
          ? `${f.match_source}:${f.match_source_id}`
          : null,
      series:
        f?.series_id && f.series_name
          ? {
              key: f.series_id,
              name: f.series_name,
              position: f.series_position,
              label: f.series_position !== null ? positionLabel(f.series_position) : null,
              unit: f.series_unit ?? 'volume',
              status: f.series_status ?? 'unknown',
              total: f.series_total,
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
          pages: chosenDetails.pages?.measured ? chosenDetails.pages.value : null,
          pdfType,
          sourcePages: sourcePages?.value ?? null,
          sourceName: sourcePages?.label ?? null,
        },
        unitFor(i.kind, f?.volume_label ?? null, f?.issue_label ?? null),
      ),
      community: selection.chosen,
      firstPublishYear: chosenDetails.firstPublishYear?.value ?? null,
      acquired,
      effort: i.user.effortOverride ?? estimateEffort(i.kind, i.isReference),
    };
  });
  attachCoverage(db, rankItems);
  const arrivals = new Map<string, string>();
  for (const i of items)
    if (i.folderIds.length > 0 && !firstScan(i, folders)) arrivals.set(i.id, i.firstSeenAt);
  return {
    items: rankItems,
    stats,
    details,
    ratings,
    library: new Map(items.map((i) => [i.id, i])),
    used,
    arrivals,
  };
}

/** Was the item first seen in its folder's first scan? Then first-seen isn't an acquisition. */
function firstScan(
  i: ItemSummary,
  folders: Map<string, { first_complete_scan_at?: string | null }>,
): boolean {
  // Seen by the first complete scan of any of its folders (or no such scan has finished yet):
  // it came with the folder. Only books first seen after that scan are new.
  for (const id of i.folderIds) {
    const first = folders.get(id)?.first_complete_scan_at;
    if (!first || i.firstSeenAt <= first) return true;
  }
  return i.folderIds.length === 0;
}

/**
 * Collections and their issues (§12.5): each series gets what its collected editions hold
 * (for gaps), and items read through another one are marked (for eligibility).
 */
export function attachCoverage(db: DB, items: RankItem[]): void {
  const rows = loadCoverage(db);
  if (rows.length === 0) return;
  const byId = new Map(items.map((i) => [i.id, i]));
  const bySeries = new Map<string, Coverage[]>();
  for (const r of rows) {
    const col = byId.get(r.item_id);
    if (!col) continue;
    const h = holdingOf(col);
    const c: Coverage = {
      id: r.id,
      itemId: r.item_id,
      title: col.displayTitle ?? col.title,
      first: r.first_num,
      last: r.last_num,
      state: r.state as Coverage['state'],
      held: h === 'owned' || h === 'read_elsewhere',
    };
    if (!bySeries.has(r.series_id)) bySeries.set(r.series_id, []);
    bySeries.get(r.series_id)!.push(c);
  }
  for (const i of items) if (i.series) i.series.coverage = bySeries.get(i.series.key) ?? [];
  const via = viaStates(
    items.map((i) => ({
      id: i.id,
      seriesKey: i.series?.key ?? null,
      unit: i.series?.unit ?? null,
      position: i.series?.position ?? null,
      finished: i.user.progress === 'finished',
    })),
    rows.map((r) => ({
      itemId: r.item_id,
      first: r.first_num,
      last: r.last_num,
      state: r.state as Coverage['state'],
      seriesKey: r.series_id,
    })),
  );
  for (const i of items) i.via = via.get(i.id) ?? null;
}
