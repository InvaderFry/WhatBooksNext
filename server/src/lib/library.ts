import type { DB } from '../db/database.ts';
import type { FolderRow } from '../scan/folders.ts';
import { normalizeForCompare } from '../identify/filename.ts';
import { HttpError, parseJson } from '../util.ts';
import { allMatchInputs, chooseUsed, decisionsFor } from '../identify/lookups.ts';
import { factsFromPrimary } from '../identify/items.ts';
import {
  chooseDetails,
  displayDetailTitle,
  type DetailFile,
  type DetailInput,
  type ItemDetails,
} from './details.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';

/**
 * Library views: items with their owner data and availability, built from the facts tables
 * and the owner's own data (kept apart, §6.5). Pure assembly — no file access here.
 */

export type FolderReachability = Map<string, boolean>;

export interface FileView {
  id: string;
  folderId: string;
  folderPath: string;
  relPath: string;
  name: string;
  format: string;
  size: number;
  availability: string;
  stale: boolean;
  isPrimary: boolean;
  folderReachable: boolean;
  storageKind: string;
  qualityTag: string | null;
  editionNumber: number | null;
  editionNote: string | null;
  language: string | null;
  modifiedMs: number | null;
  firstSeenAt: string;
  hasThumbnail: boolean;
}

export interface UserData {
  progress: string;
  dnfReason: string | null;
  startedOn: string | null;
  startedPrecision: string | null;
  finishedOn: string | null;
  finishedPrecision: string | null;
  progressAt: string | null;
  rating: number | null;
  note: string | null;
  takeaway: string | null;
  hidden: boolean;
  shortlistPosition: number | null;
  titleOverride: string | null;
  kindOverride: string | null;
  referenceOverride: boolean | null;
  icloudOverride: 'in' | 'not_in' | null;
  triage: 'want' | 'maybe' | 'never' | null;
  effortOverride: 'light' | 'medium' | 'heavy' | null;
  preferredFileId: string | null;
  /** The owner's series name ('' = not in a series), or null to let the app decide. */
  seriesOverride: string | null;
  seriesPositionOverride: number | null;
  /** "Still reading?" snoozed until this date (§13.6). */
  stillReadingSnoozedUntil: string | null;
  /** "Still relevant?" → Decide later (§13.10): when the owner put it off. */
  relevanceDeferredAt: string | null;
  updatedAt: string | null;
}

/** The online rating recommendations use, as the Library shows and sorts it. */
export interface LibraryRating {
  /** 0–100 after adjusting for how many people rated it (what ranking uses). */
  score: number;
  /** As the source states it, e.g. 4.2 of 5. */
  raw: number;
  scale: number;
  votes: number | null;
  source: string;
  sourceLabel: string;
  scope: 'book' | 'volume' | 'series';
  unconfirmed: boolean;
}

export interface ItemSummary {
  id: string;
  title: string;
  /** The title from the files, shown when the owner has overridden it. */
  factTitle: string;
  kind: string | null;
  kindIsGuess: boolean;
  isReference: boolean;
  seriesHint: string | null;
  /** The series this item is in, and its number there (§12.5). */
  series: { id: string; name: string; position: number | null; unit: 'volume' | 'issue' } | null;
  creators: { name: string; role?: string }[];
  /** Filled by the Library route; null when no online rating is known. */
  community?: LibraryRating | null;
  /** A file of this item with a thumbnail (its cover is served by this file id), or null. */
  coverFileId: string | null;
  formats: string[];
  fileCount: number;
  folderIds: string[];
  availability: AvailabilityView;
  user: UserData;
  firstSeenAt: string;
}

export interface AvailabilityView {
  /** present | not_connected | online_only | unknown | missing | none */
  state: string;
  /** Plain-language label, e.g. "On external drive (not connected)". Null when ready on this PC. */
  label: string | null;
  alsoInICloud: boolean;
  /** Ready to read (§13.1): a present file, or a place the owner confirmed they can read from. */
  readyToRead: boolean;
  /**
   * Links to read it in a store (Store links), copies the owner can read there first. Shown as
   * "Read in Kindle ↗"; `host` is shown for "another app" so the owner sees where it goes.
   */
  storeLinks?: { store: string; url: string; kind: 'read' | 'page'; host: string }[];
}

const DEFAULT_USER: UserData = {
  progress: 'not_started',
  dnfReason: null,
  startedOn: null,
  startedPrecision: null,
  finishedOn: null,
  finishedPrecision: null,
  progressAt: null,
  rating: null,
  note: null,
  takeaway: null,
  hidden: false,
  shortlistPosition: null,
  titleOverride: null,
  kindOverride: null,
  referenceOverride: null,
  icloudOverride: null,
  triage: null,
  effortOverride: null,
  preferredFileId: null,
  seriesOverride: null,
  seriesPositionOverride: null,
  stillReadingSnoozedUntil: null,
  relevanceDeferredAt: null,
  updatedAt: null,
};

interface UserRow {
  item_id: string;
  progress: string;
  dnf_reason: string | null;
  started_on: string | null;
  started_precision: string | null;
  finished_on: string | null;
  finished_precision: string | null;
  progress_at: string | null;
  rating: number | null;
  note: string | null;
  takeaway: string | null;
  hidden: number;
  shortlist_position: number | null;
  title_override: string | null;
  kind_override: string | null;
  reference_override: number | null;
  icloud_override: 'in' | 'not_in' | null;
  triage: 'want' | 'maybe' | 'never' | null;
  effort_override: 'light' | 'medium' | 'heavy' | null;
  preferred_file_id: string | null;
  series_override: string | null;
  series_position_override: number | null;
  still_reading_snoozed_until: string | null;
  relevance_deferred_at: string | null;
  updated_at: string;
}

export function userFromRow(r: UserRow | undefined): UserData {
  if (!r) return { ...DEFAULT_USER };
  return {
    progress: r.progress,
    dnfReason: r.dnf_reason,
    startedOn: r.started_on,
    startedPrecision: r.started_precision,
    finishedOn: r.finished_on,
    finishedPrecision: r.finished_precision,
    progressAt: r.progress_at,
    rating: r.rating,
    note: r.note,
    takeaway: r.takeaway,
    hidden: r.hidden === 1,
    shortlistPosition: r.shortlist_position,
    titleOverride: r.title_override,
    kindOverride: r.kind_override,
    referenceOverride: r.reference_override === null ? null : r.reference_override === 1,
    icloudOverride: r.icloud_override,
    triage: r.triage,
    effortOverride: r.effort_override,
    preferredFileId: r.preferred_file_id,
    seriesOverride: r.series_override,
    seriesPositionOverride: r.series_position_override,
    stillReadingSnoozedUntil: r.still_reading_snoozed_until ?? null,
    relevanceDeferredAt: r.relevance_deferred_at ?? null,
    updatedAt: r.updated_at,
  };
}

interface ItemRow {
  id: string;
  kind: string | null;
  kind_source: string | null;
  is_reference: number;
  title: string;
  series_hint: string | null;
  series_id: string | null;
  series_position: number | null;
  series_unit: 'volume' | 'issue' | null;
  series_name: string | null;
  creators: string;
  created_at: string;
  online_title: string | null;
  title_source: string | null;
  issue_label: string | null;
}

interface FileJoinRow {
  item_id: string;
  is_primary: number;
  metadata: string | null;
  parsed: string;
  page_count: number | null;
  pdf_type: string | null;
  id: string;
  folder_id: string;
  rel_path: string;
  name: string;
  format: string;
  size: number;
  availability: string;
  stale: number;
  quality_tag: string | null;
  edition_number: number | null;
  edition_note: string | null;
  language: string | null;
  modified_ms: number | null;
  first_seen_at: string;
  has_thumbnail: number;
}

const STORE_LABELS: Record<string, string> = {
  kindle: 'Kindle',
  kobo: 'Kobo',
  globalcomix: 'GlobalComix',
  apple_books: 'Apple Books',
  google_play: 'Google Play Books',
  other: 'another app',
};

export function availabilityFor(
  files: FileView[],
  folders: Map<string, FolderRow>,
  user: UserData,
  confirmedLocations: { store: string | null }[],
  storeLocations: {
    store: string | null;
    url?: string | null;
    url_kind?: string | null;
    confirmed_readable?: number;
  }[],
): AvailabilityView {
  // "Also in iCloud": the folder is marked, unless this item says otherwise (§13.1).
  const folderSaysICloud = files.some((f) => folders.get(f.folderId)?.also_in_icloud === 1);
  const alsoInICloud =
    user.icloudOverride === 'in' || (user.icloudOverride !== 'not_in' && folderSaysICloud);

  const reachable = files.filter((f) => f.folderReachable);
  let state = 'none';
  let label: string | null = null;
  if (reachable.some((f) => f.availability === 'present')) {
    state = 'present';
  } else if (reachable.some((f) => f.availability === 'placeholder')) {
    state = 'online_only';
    label = 'Online only (not downloaded)';
    const f = reachable.find((x) => x.availability === 'placeholder')!;
    if (/icloud/i.test(f.folderPath)) label = 'In iCloud (not downloaded)';
    else if (/onedrive/i.test(f.folderPath)) label = 'In OneDrive (not downloaded)';
  } else if (files.some((f) => !f.folderReachable && f.availability !== 'missing')) {
    state = 'not_connected';
    const f = files.find((x) => !x.folderReachable && x.availability !== 'missing')!;
    label =
      f.storageKind === 'external' ? 'On external drive (not connected)' : 'Folder not reachable';
  } else if (reachable.some((f) => f.availability === 'unknown')) {
    state = 'unknown';
    label = 'Availability unknown';
  } else if (files.length > 0) {
    state = 'missing';
    label = 'File missing';
  } else if (storeLocations.length > 0) {
    state = 'store';
    label = `In ${STORE_LABELS[storeLocations[0]!.store ?? 'other'] ?? 'another app'}`;
  }
  const readyToRead = state === 'present' || alsoInICloud || confirmedLocations.length > 0;
  const storeLinks = storeLocations
    .filter((l) => l.url)
    .sort((a, b) => (b.confirmed_readable ?? 0) - (a.confirmed_readable ?? 0))
    .map((l) => ({
      store: l.store ?? 'other',
      url: l.url!,
      kind: (l.url_kind === 'read' ? 'read' : 'page') as 'read' | 'page',
      host: new URL(l.url!).hostname,
    }));
  return { state, label, alsoInICloud, readyToRead, storeLinks };
}

export interface LibraryData {
  items: ItemSummary[];
  folders: Map<string, FolderRow>;
  details: Map<string, ItemDetails>;
  /** Original title/creators used by taste and topic rules; display choices must not change them. */
  rankingFacts: Map<string, { title: string; creators: ItemSummary['creators'] }>;
  detailInputs: Map<string, DetailInput>;
}

/** Loads every item with files and owner data. A few thousand items take milliseconds. */
export function loadLibrary(db: DB, reach: FolderReachability, onlyIds?: string[]): LibraryData {
  const folders = new Map(
    (db.prepare('SELECT * FROM folders').all() as FolderRow[]).map((f) => [f.id, f]),
  );
  const filter = onlyIds ? `WHERE i.id IN (${onlyIds.map(() => '?').join(',')})` : '';
  // Preserve the Stage 1 title only as a ranking/topic input. Display titles are chosen
  // independently below; changing display facts must not change learned taste or topics.
  const items = db
    .prepare(
      `SELECT i.*, CASE WHEN i.identity = 'accepted' AND COALESCE(i.title_source, 'filename') NOT IN ('embedded', 'owner')
           THEN json_extract(m.data, '$.title') END AS online_title, s.name AS series_name
       FROM items i LEFT JOIN series s ON s.id = i.series_id
       LEFT JOIN item_matches m ON m.item_id = i.id AND m.source = i.match_source
         AND m.source_id = i.match_source_id ${filter}`,
    )
    .all(...(onlyIds ?? [])) as ItemRow[];
  const users = new Map(
    (db.prepare('SELECT * FROM user_item').all() as UserRow[]).map((u) => [u.item_id, u]),
  );
  const files = new Map<string, FileView[]>();
  const detailFiles = new Map<string, DetailFile[]>();
  for (const r of db
    .prepare(
      `SELECT x.item_id, x.is_primary, f.id, f.folder_id, f.rel_path, f.name, f.format, f.size,
         f.availability, f.stale, f.quality_tag, f.edition_number, f.edition_note, f.language,
         f.modified_ms, f.first_seen_at, f.has_thumbnail, f.metadata, f.parsed, f.page_count, f.pdf_type
       FROM item_files x JOIN files f ON f.id = x.file_id ORDER BY x.item_id, x.is_primary DESC, f.id`,
    )
    .all() as FileJoinRow[]) {
    const folder = folders.get(r.folder_id);
    const view: FileView = {
      id: r.id,
      folderId: r.folder_id,
      folderPath: folder?.display_path ?? '',
      relPath: r.rel_path,
      name: r.name,
      format: r.format,
      size: r.size,
      availability: r.availability,
      stale: r.stale === 1,
      isPrimary: r.is_primary === 1,
      folderReachable: reach.get(r.folder_id) ?? false,
      storageKind: folder?.storage_kind ?? 'local',
      qualityTag: r.quality_tag,
      editionNumber: r.edition_number,
      editionNote: r.edition_note,
      language: r.language,
      modifiedMs: r.modified_ms,
      firstSeenAt: r.first_seen_at,
      hasThumbnail: r.has_thumbnail === 1,
    };
    if (!files.has(r.item_id)) files.set(r.item_id, []);
    files.get(r.item_id)!.push(view);
    if (!detailFiles.has(r.item_id)) detailFiles.set(r.item_id, []);
    const facts = factsFromPrimary({
      name: r.name,
      format: r.format,
      parsed: r.parsed,
      metadata: r.metadata,
      pdf_type: r.pdf_type,
      pdf_type_override: null,
    });
    const df: DetailFile = {
      id: r.id,
      metadata: parseJson<EmbeddedMetadata | null>(r.metadata, null),
      title: facts.titleSource === 'embedded' ? facts.title : null,
      creators: facts.creators,
      pages: r.page_count,
    };
    if (r.is_primary) detailFiles.get(r.item_id)!.unshift(df);
    else detailFiles.get(r.item_id)!.push(df);
  }
  type LocationRow = {
    item_id: string;
    kind: string;
    store: string | null;
    confirmed_readable: number;
    url: string | null;
    url_kind: string | null;
  };
  const locations = new Map<string, LocationRow[]>();
  for (const l of db
    .prepare(
      'SELECT item_id, kind, store, confirmed_readable, url, url_kind FROM locations ORDER BY created_at, id',
    )
    .all() as LocationRow[]) {
    if (!locations.has(l.item_id)) locations.set(l.item_id, []);
    locations.get(l.item_id)!.push(l);
  }

  const { matches, rejected, overrides } = allMatchInputs(db);
  const details = new Map<string, ItemDetails>();
  const detailInputs = new Map<string, DetailInput>();
  const rankingFacts = new Map<string, { title: string; creators: ItemSummary['creators'] }>();
  const out: ItemSummary[] = items.map((i) => {
    const user = userFromRow(users.get(i.id));
    const fs = (files.get(i.id) ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const locs = locations.get(i.id) ?? [];
    const stores = locs.filter((l) => l.kind === 'store');
    const kind = user.kindOverride ?? i.kind;
    const candidates = matches.get(i.id) ?? [];
    const no = rejected.get(i.id) ?? new Set<string>();
    const override = overrides.get(i.id) ?? null;
    const decisions = decisionsFor(candidates, no);
    const input: DetailInput = {
      fallbackTitle: i.title,
      ownerTitle: user.titleOverride ?? (i.title_source === 'owner' ? i.title : null),
      files: detailFiles.get(i.id) ?? [],
      storedCreators: fs.length === 0 ? parseJson(i.creators, []) : [],
      issue: !!i.issue_label,
      matches: chooseUsed(candidates, override, no).map((m) => ({
        record: m.record,
        decision:
          override === `${m.source}:${m.sourceId}`
            ? 'confirmed'
            : (decisions.get(m.source)!.decision as 'accepted' | 'provisional'),
        strongIsbn: m.evidence.isbn === 'strong',
        score: m.score,
      })),
    };
    const d = chooseDetails(input);
    details.set(i.id, d);
    detailInputs.set(i.id, input);
    rankingFacts.set(i.id, {
      title: user.titleOverride ?? i.online_title ?? i.title,
      creators: parseJson(i.creators, []),
    });
    return {
      id: i.id,
      title: displayDetailTitle(d),
      factTitle: i.title,
      kind,
      kindIsGuess: !user.kindOverride && i.kind !== null,
      isReference: user.referenceOverride ?? i.is_reference === 1,
      seriesHint: i.series_hint,
      series:
        i.series_id && i.series_name
          ? {
              id: i.series_id,
              name: i.series_name,
              position: i.series_position,
              unit: i.series_unit ?? 'volume',
            }
          : null,
      creators: d.creators?.value ?? [],
      // The primary file's cover first (files are sorted primary-first).
      coverFileId: fs.find((f) => f.hasThumbnail)?.id ?? null,
      formats: [...new Set(fs.map((f) => f.format))],
      fileCount: fs.length,
      folderIds: [...new Set(fs.map((f) => f.folderId))],
      availability: availabilityFor(
        fs,
        folders,
        user,
        stores.filter((s) => s.confirmed_readable === 1),
        stores,
      ),
      user,
      firstSeenAt: fs.map((f) => f.firstSeenAt).sort()[0] ?? i.created_at,
    };
  });
  return { items: out, folders, details, rankingFacts, detailInputs };
}

export interface LibraryQuery {
  q?: string;
  kind?: string;
  progress?: string;
  format?: string;
  availability?: string;
  folder?: string;
  shortlisted?: boolean;
  readyToRead?: boolean;
  showHidden?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Filters and sorts a loaded library. Pure, so it is testable without a database. */
export function queryLibrary(
  items: ItemSummary[],
  q: LibraryQuery,
): { total: number; items: ItemSummary[] } {
  let list = items;
  if (!q.showHidden) list = list.filter((i) => !i.user.hidden);
  if (q.q) {
    // Spaces and punctuation are ignored, so "mapmaking" finds "Map Making" and vice versa.
    const needle = normalizeForCompare(q.q);
    list = list.filter(
      (i) =>
        normalizeForCompare(i.title).includes(needle) ||
        normalizeForCompare(i.factTitle).includes(needle),
    );
  }
  if (q.kind)
    list = list.filter((i) => (q.kind === 'unknown' ? i.kind === null : i.kind === q.kind));
  if (q.progress) list = list.filter((i) => i.user.progress === q.progress);
  if (q.format) list = list.filter((i) => i.formats.includes(q.format!));
  if (q.availability) list = list.filter((i) => i.availability.state === q.availability);
  if (q.folder) list = list.filter((i) => i.folderIds.includes(q.folder!));
  if (q.shortlisted) list = list.filter((i) => i.user.shortlistPosition !== null);
  if (q.readyToRead) list = list.filter((i) => i.availability.readyToRead);

  const dir = q.dir === 'desc' ? -1 : 1;
  const sort = q.sort ?? 'title';
  const cmp: Record<string, (a: ItemSummary, b: ItemSummary) => number> = {
    title: (a, b) => collator.compare(a.title, b.title),
    added: (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt),
    touched: (a, b) => (a.user.progressAt ?? '').localeCompare(b.user.progressAt ?? ''),
    rating: (a, b) => (a.user.rating ?? -1) - (b.user.rating ?? -1),
    // The adjusted score, so 5.0 from 2 ratings doesn't jump ahead of 4.3 from 5,000; then more
    // ratings first. Books with no online rating are placed last below, in either direction.
    community: (a, b) =>
      a.community!.score - b.community!.score ||
      (a.community!.votes ?? -1) - (b.community!.votes ?? -1),
  };
  const by = cmp[sort];
  if (!by) throw new HttpError(400, `Unknown sort "${sort}".`);
  list = [...list].sort((a, b) => {
    if (sort === 'community' && !a.community !== !b.community) return a.community ? -1 : 1;
    const both = sort !== 'community' || (a.community && b.community);
    return (both ? by(a, b) * dir : 0) || collator.compare(a.title, b.title);
  });
  const offset = q.offset ?? 0;
  const limit = Math.min(q.limit ?? 100, 1000);
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

/** Items only read elsewhere: a history location, no files and no store copy (§7). */
export function historyOnlyIds(db: DB): Set<string> {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT l.item_id FROM locations l WHERE l.kind = 'history'
         AND NOT EXISTS (SELECT 1 FROM item_files x WHERE x.item_id = l.item_id)
         AND NOT EXISTS (SELECT 1 FROM locations s WHERE s.item_id = l.item_id AND s.kind = 'store')`,
      )
      .pluck()
      .all() as string[],
  );
}

export function resolveItemId(db: DB, id: string): string | null {
  if (db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return id;
  const alias = db.prepare('SELECT new_id FROM id_aliases WHERE old_id = ?').pluck().get(id) as
    string | undefined;
  return alias ?? null;
}

export function itemParse(db: DB, itemId: string): unknown {
  const primary = db
    .prepare(
      'SELECT f.parsed FROM item_files x JOIN files f ON f.id = x.file_id WHERE x.item_id = ? AND x.is_primary = 1',
    )
    .pluck()
    .get(itemId) as string | undefined;
  return parseJson(primary, null);
}
