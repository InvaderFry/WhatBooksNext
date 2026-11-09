import type { DB } from '../db/database.ts';
import type { FolderRow } from '../scan/folders.ts';
import { normalizeForCompare } from '../identify/filename.ts';
import { HttpError, parseJson } from '../util.ts';

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
  updatedAt: string | null;
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
  created_at: string;
}

interface FileJoinRow {
  item_id: string;
  is_primary: number;
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
  storeLocations: { store: string | null }[],
): AvailabilityView {
  // "Also in iCloud": the folder is marked, unless this item says otherwise (§13.1).
  const folderSaysICloud = files.some((f) => folders.get(f.folderId)?.also_in_icloud === 1);
  const alsoInICloud = user.icloudOverride === 'in' || (user.icloudOverride !== 'not_in' && folderSaysICloud);

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
    label = f.storageKind === 'external' ? 'On external drive (not connected)' : 'Folder not reachable';
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
  return { state, label, alsoInICloud, readyToRead };
}

export interface LibraryData {
  items: ItemSummary[];
  folders: Map<string, FolderRow>;
}

/** Loads every item with files and owner data. A few thousand items take milliseconds. */
export function loadLibrary(db: DB, reach: FolderReachability, onlyIds?: string[]): LibraryData {
  const folders = new Map((db.prepare('SELECT * FROM folders').all() as FolderRow[]).map((f) => [f.id, f]));
  const filter = onlyIds ? `WHERE i.id IN (${onlyIds.map(() => '?').join(',')})` : '';
  const items = db.prepare(`SELECT i.* FROM items i ${filter}`).all(...(onlyIds ?? [])) as ItemRow[];
  const users = new Map(
    (db.prepare('SELECT * FROM user_item').all() as UserRow[]).map((u) => [u.item_id, u]),
  );
  const files = new Map<string, FileView[]>();
  for (const r of db
    .prepare(
      `SELECT x.item_id, x.is_primary, f.id, f.folder_id, f.rel_path, f.name, f.format, f.size,
         f.availability, f.stale, f.quality_tag, f.edition_number, f.edition_note, f.language,
         f.modified_ms, f.first_seen_at
       FROM item_files x JOIN files f ON f.id = x.file_id`,
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
    };
    if (!files.has(r.item_id)) files.set(r.item_id, []);
    files.get(r.item_id)!.push(view);
  }
  const locations = new Map<string, { kind: string; store: string | null; confirmed_readable: number }[]>();
  for (const l of db.prepare('SELECT item_id, kind, store, confirmed_readable FROM locations').all() as {
    item_id: string;
    kind: string;
    store: string | null;
    confirmed_readable: number;
  }[]) {
    if (!locations.has(l.item_id)) locations.set(l.item_id, []);
    locations.get(l.item_id)!.push(l);
  }

  const out: ItemSummary[] = items.map((i) => {
    const user = userFromRow(users.get(i.id));
    const fs = (files.get(i.id) ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const locs = locations.get(i.id) ?? [];
    const stores = locs.filter((l) => l.kind === 'store');
    const kind = user.kindOverride ?? i.kind;
    return {
      id: i.id,
      title: user.titleOverride ?? i.title,
      factTitle: i.title,
      kind,
      kindIsGuess: !user.kindOverride && i.kind !== null,
      isReference: user.referenceOverride ?? i.is_reference === 1,
      seriesHint: i.series_hint,
      formats: [...new Set(fs.map((f) => f.format))],
      fileCount: fs.length,
      folderIds: [...new Set(fs.map((f) => f.folderId))],
      availability: availabilityFor(fs, folders, user, stores.filter((s) => s.confirmed_readable === 1), stores),
      user,
      firstSeenAt: fs.map((f) => f.firstSeenAt).sort()[0] ?? i.created_at,
    };
  });
  return { items: out, folders };
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
export function queryLibrary(items: ItemSummary[], q: LibraryQuery): { total: number; items: ItemSummary[] } {
  let list = items;
  if (!q.showHidden) list = list.filter((i) => !i.user.hidden);
  if (q.q) {
    // Spaces and punctuation are ignored, so "mapmaking" finds "Map Making" and vice versa.
    const needle = normalizeForCompare(q.q);
    list = list.filter((i) => normalizeForCompare(i.title).includes(needle) || normalizeForCompare(i.factTitle).includes(needle));
  }
  if (q.kind) list = list.filter((i) => (q.kind === 'unknown' ? i.kind === null : i.kind === q.kind));
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
  };
  const by = cmp[sort];
  if (!by) throw new HttpError(400, `Unknown sort "${sort}".`);
  list = [...list].sort((a, b) => by(a, b) * dir || collator.compare(a.title, b.title));
  const offset = q.offset ?? 0;
  const limit = Math.min(q.limit ?? 100, 1000);
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

export function resolveItemId(db: DB, id: string): string | null {
  if (db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return id;
  const alias = db.prepare('SELECT new_id FROM id_aliases WHERE old_id = ?').pluck().get(id) as string | undefined;
  return alias ?? null;
}

export function itemParse(db: DB, itemId: string): unknown {
  const primary = db
    .prepare('SELECT f.parsed FROM item_files x JOIN files f ON f.id = x.file_id WHERE x.item_id = ? AND x.is_primary = 1')
    .pluck()
    .get(itemId) as string | undefined;
  return parseJson(primary, null);
}
