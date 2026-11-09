import type { DB } from '../db/database.ts';
import { newId, nowIso, parseJson } from '../util.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';
import { normalizeForCompare, titleCase, type ParsedName } from './filename.ts';

/** Facts about one file needed to group it and pick a primary (subset of a `files` row). */
export interface FileFacts {
  id: string;
  folder_id: string;
  rel_dir: string;
  name: string;
  format: string;
  size: number;
  availability: string;
  partial_hash: string | null;
  full_hash: string | null;
  quality_tag: string | null;
  edition_number: number | null;
  language: string | null;
  abridged: number | null;
  compare_key: string;
  rel_path: string;
  parsed: string;
}

const COMIC_FORMATS = new Set(['cbz', 'cbr', 'cb7']);

/** Display title from the filename parse. Lowercase slug text gets title case for display only. */
export function displayTitle(p: ParsedName): string {
  const tc = (t: string) => (t === t.toLowerCase() ? titleCase(t) : t);
  const series = p.series ? tc(p.series.value) : undefined;
  const subtitle = p.subtitle ? tc(p.subtitle.value) : undefined;
  let t: string;
  if (series && p.issue) {
    const sv =
      p.seriesVolume && !p.seriesVolume.value.startsWith('season')
        ? ` v${p.seriesVolume.value}`
        : '';
    t = `${series}${sv} #${p.issue.value}${subtitle ? `: ${subtitle}` : ''}`;
  } else if (series && p.volume) {
    t = `${series} Vol. ${p.volume.value}${subtitle ? `: ${subtitle}` : ''}`;
  } else {
    t = tc(p.title.value) + (subtitle && !series ? `: ${subtitle}` : '');
  }
  if (p.editionNumber) t += ` (${ordinal(p.editionNumber)} edition)`;
  return t;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/**
 * Kind from what the files alone can say. Comic archives are comics; nothing else is known
 * until sources are looked up (M3), so it stays unknown (null) rather than a guess (§4).
 */
export function kindFromFiles(files: FileFacts[]): { kind: string | null; source: string | null } {
  if (files.length > 0 && files.every((f) => COMIC_FORMATS.has(f.format)))
    return { kind: 'comic', source: 'format' };
  return { kind: null, source: null };
}

const AVAILABILITY_RANK: Record<string, number> = {
  present: 0,
  placeholder: 1,
  unknown: 2,
  missing: 3,
};
const PROSE_FORMAT_RANK: Record<string, number> = {
  epub: 0,
  pdf: 1,
  mobi: 2,
  azw3: 3,
  cbz: 4,
  cbr: 5,
  cb7: 6,
};
const COMIC_FORMAT_RANK: Record<string, number> = {
  cbz: 0,
  cbr: 1,
  cb7: 2,
  pdf: 3,
  epub: 4,
  mobi: 5,
  azw3: 6,
};

/**
 * Primary file (what Open uses and whose length counts, §11.3): a present file before a
 * placeholder before a missing one; then EPUB for prose, the HD version for comics, then other
 * formats. Ties break on the shortest path so the choice is stable.
 */
export function choosePrimary(files: FileFacts[], kind: string | null): FileFacts | undefined {
  const comic = kind === 'comic' || kind === 'manga';
  const fmtRank = comic ? COMIC_FORMAT_RANK : PROSE_FORMAT_RANK;
  return [...files].sort(
    (a, b) =>
      (AVAILABILITY_RANK[a.availability] ?? 9) - (AVAILABILITY_RANK[b.availability] ?? 9) ||
      (comic ? Number(Boolean(b.quality_tag)) - Number(Boolean(a.quality_tag)) : 0) ||
      (fmtRank[a.format] ?? 9) - (fmtRank[b.format] ?? 9) ||
      a.rel_path.length - b.rel_path.length ||
      a.id.localeCompare(b.id),
  )[0];
}

export function createItemForFiles(db: DB, files: FileFacts[]): string {
  const { kind, source } = kindFromFiles(files);
  const primary = choosePrimary(files, kind)!;
  const p = parseJson<ParsedName | null>(primary.parsed, null);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO items (id, kind, kind_source, title, series_hint, volume_label, issue_label,
       publication_year, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    source,
    p ? displayTitle(p) : primary.name,
    p?.series?.value ?? null,
    p?.volume?.value ?? null,
    p?.issue?.value ?? null,
    null, // a year in a filename is the edition's or issue's, not first publication: unknown
    now,
    now,
  );
  const ins = db.prepare('INSERT INTO item_files (item_id, file_id, is_primary) VALUES (?, ?, 0)');
  for (const f of files) ins.run(id, f.id);
  refreshPrimary(db, id);
  return id;
}

export function attachFiles(db: DB, itemId: string, files: FileFacts[]): void {
  const ins = db.prepare('INSERT INTO item_files (item_id, file_id, is_primary) VALUES (?, ?, 0)');
  for (const f of files) ins.run(itemId, f.id);
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(nowIso(), itemId);
  refreshPrimary(db, itemId);
}

export function filesOfItem(db: DB, itemId: string): FileFacts[] {
  return db
    .prepare(`SELECT f.* FROM files f JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ?`)
    .all(itemId) as FileFacts[];
}

export function refreshPrimary(db: DB, itemId: string): void {
  const item = db.prepare('SELECT kind FROM items WHERE id = ?').get(itemId) as
    { kind: string | null } | undefined;
  if (!item) return;
  const primary = choosePrimary(filesOfItem(db, itemId), item.kind);
  db.prepare(
    'UPDATE item_files SET is_primary = CASE WHEN file_id = ? THEN 1 ELSE 0 END WHERE item_id = ?',
  ).run(primary?.id ?? null, itemId);
}

export function refreshAllPrimaries(db: DB): void {
  const ids = db.prepare('SELECT id FROM items').pluck().all() as string[];
  for (const id of ids) refreshPrimary(db, id);
}

/** Does the owner have anything recorded on this item? (Then it is never silently deleted.) */
export function hasOwnerData(db: DB, itemId: string): boolean {
  const u = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(itemId) as
    Record<string, unknown> | undefined;
  const loc = db.prepare('SELECT 1 FROM locations WHERE item_id = ? LIMIT 1').get(itemId);
  if (loc) return true;
  if (!u) return false;
  const defaults: Record<string, unknown> = { progress: 'not_started', hidden: 0 };
  return Object.entries(u).some(
    ([k, v]) => !['item_id', 'updated_at'].includes(k) && v !== null && v !== (defaults[k] ?? null),
  );
}

/** Removes items with no files and no owner data (e.g. after a folder is removed). */
export function removeOrphanItems(db: DB): number {
  const orphans = db
    .prepare(
      'SELECT id FROM items i WHERE NOT EXISTS (SELECT 1 FROM item_files x WHERE x.item_id = i.id)',
    )
    .pluck()
    .all() as string[];
  let removed = 0;
  const now = nowIso();
  for (const id of orphans) {
    if (hasOwnerData(db, id)) continue;
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    db.prepare(
      'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
    ).run('item', id, now);
    removed++;
  }
  return removed;
}

/** The facts the primary file says about its item: its own metadata first, then its name. */
export interface ItemFacts {
  title: string;
  titleSource: 'embedded' | 'filename';
  creators: { name: string; role?: string }[];
  seriesHint: string | null;
  volume: string | null;
  issue: string | null;
  kind: string | null;
  kindSource: string | null;
}

interface PrimaryRow {
  name: string;
  format: string;
  parsed: string;
  metadata: string | null;
  pdf_type: string | null;
  pdf_type_override: string | null;
}

/**
 * Should a PDF's own Title be trusted? PDF tools write all sorts into it (a chapter name, the
 * typesetter's file, a series name), so it's used only when most of its words appear in the
 * filename too — corroborated, never on its own (§11.2 cautious matching). EPUB titles are
 * strong evidence and need no corroboration.
 */
export function pdfTitleAgrees(pdfTitle: string, fileName: string): boolean {
  const name = normalizeForCompare(fileName);
  const words = pdfTitle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  return words.filter((w) => name.includes(w)).length / words.length >= 0.5;
}

export function factsFromPrimary(p: PrimaryRow): ItemFacts {
  const parse = parseJson<ParsedName | null>(p.parsed, null);
  const md = parseJson<EmbeddedMetadata | null>(p.metadata, null);
  const f: ItemFacts = {
    title: parse ? displayTitle(parse) : p.name,
    titleSource: 'filename',
    creators: [],
    seriesHint: parse?.series?.value ?? null,
    volume: parse?.volume?.value ?? null,
    issue: parse?.issue?.value ?? null,
    kind: null,
    kindSource: null,
  };
  if (md) {
    const comic = md.comic;
    if (comic?.series && comic.number) {
      f.title = `${comic.series} #${comic.number}${comic.title ? `: ${comic.title}` : ''}`;
      f.titleSource = 'embedded';
      f.seriesHint = comic.series;
      f.issue = comic.number;
      f.volume = null;
    } else if (md.title && (p.format !== 'pdf' || pdfTitleAgrees(md.title, p.name))) {
      // Editions stay distinguishable (§11.3): the filename's edition joins the file's title.
      const ed = parse?.editionNumber;
      f.title =
        ed && !/edition|ed\./i.test(md.title) ? `${md.title} (${ordinal(ed)} edition)` : md.title;
      f.titleSource = 'embedded';
      if (md.series) {
        f.seriesHint = md.series;
        f.volume = md.seriesIndex ?? f.volume;
      }
    }
    if (md.creators?.length) f.creators = md.creators;
  }
  // Kind from what the file says about itself. Sources (M3) and the owner can say more.
  const pdfType = p.pdf_type_override ?? p.pdf_type;
  if (md?.comic?.manga === 'yes' || md?.comic?.manga === 'yes_rtl') {
    f.kind = 'manga';
    f.kindSource = 'comicinfo';
  } else if (COMIC_FORMATS.has(p.format)) {
    f.kind = 'comic';
    f.kindSource = 'format';
  } else if (p.format === 'pdf' && pdfType === 'comic') {
    f.kind = 'comic';
    f.kindSource = 'pdf_type';
  }
  return f;
}

/** Kind sources the deep pass may revise; anything else (a source lookup, M3) it leaves alone. */
const FILE_KIND_SOURCES = new Set(['format', 'pdf_type', 'comicinfo']);

/**
 * Refreshes the facts of the items holding these files (title, creators, series hint, volume,
 * issue, kind) from each item's primary file. Only facts change — the owner's own title, kind
 * and other corrections live in user_item and are untouched. (From M3, facts from online
 * sources outrank the file; this then applies only where the file is still the source.)
 */
export function refreshItemFacts(db: DB, fileIds: string[]): number {
  if (fileIds.length === 0) return 0;
  const itemOf = db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
  const itemIds = new Set<string>();
  for (const f of fileIds) {
    const i = itemOf.get(f) as string | undefined;
    if (i) itemIds.add(i);
  }
  return refreshFactsOfItems(db, [...itemIds]);
}

export function refreshFactsOfItems(db: DB, itemIds: string[]): number {
  const primary = db.prepare(
    `SELECT f.name, f.format, f.parsed, f.metadata, f.pdf_type, u.pdf_type_override
     FROM item_files x JOIN files f ON f.id = x.file_id LEFT JOIN file_user u ON u.file_id = f.id
     WHERE x.item_id = ? AND x.is_primary = 1`,
  );
  const current = db.prepare('SELECT kind, kind_source FROM items WHERE id = ?');
  const update = db.prepare(
    `UPDATE items SET title = @title, title_source = @titleSource, creators = @creators,
       series_hint = @seriesHint, volume_label = @volume, issue_label = @issue,
       kind = @kind, kind_source = @kindSource, updated_at = @now
     WHERE id = @id AND (title IS NOT @title OR title_source IS NOT @titleSource
       OR creators IS NOT @creators OR series_hint IS NOT @seriesHint OR volume_label IS NOT @volume
       OR issue_label IS NOT @issue OR kind IS NOT @kind OR kind_source IS NOT @kindSource)`,
  );
  let changed = 0;
  const now = nowIso();
  for (const id of itemIds) {
    const p = primary.get(id) as PrimaryRow | undefined;
    const cur = current.get(id) as { kind: string | null; kind_source: string | null } | undefined;
    if (!p || !cur) continue;
    const f = factsFromPrimary(p);
    // A kind from somewhere other than the file itself is kept.
    const keepKind = cur.kind_source !== null && !FILE_KIND_SOURCES.has(cur.kind_source);
    changed += update.run({
      id,
      now,
      title: f.title,
      titleSource: f.titleSource,
      creators: JSON.stringify(f.creators),
      seriesHint: f.seriesHint,
      volume: f.volume,
      issue: f.issue,
      kind: keepKind ? cur.kind : f.kind,
      kindSource: keepKind ? cur.kind_source : f.kindSource,
    }).changes;
  }
  return changed;
}

/**
 * Moves every file of `fromId` onto `intoId` and retires `fromId` as an alias (§6.5). Only for
 * an item with no owner data: merging two items' history needs the M4 merge with a preview.
 */
export function mergeInto(db: DB, fromId: string, intoId: string): void {
  if (fromId === intoId) return;
  if (hasOwnerData(db, fromId)) throw new Error('Both items have history; merge them by hand.');
  const now = nowIso();
  db.prepare('UPDATE item_files SET item_id = ?, is_primary = 0 WHERE item_id = ?').run(
    intoId,
    fromId,
  );
  db.prepare('DELETE FROM user_item WHERE item_id = ?').run(fromId);
  db.prepare('DELETE FROM items WHERE id = ?').run(fromId);
  db.prepare('UPDATE id_aliases SET new_id = ? WHERE new_id = ?').run(intoId, fromId);
  db.prepare('INSERT OR REPLACE INTO id_aliases (old_id, new_id, created_at) VALUES (?, ?, ?)').run(
    fromId,
    intoId,
    now,
  );
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, intoId);
  refreshPrimary(db, intoId);
}
