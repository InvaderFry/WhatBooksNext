import {
  ISBN_LEAD_SEARCHES,
  LOOKUP_STOP_AFTER_FAILED_ITEMS,
  PICTURE_MIN_PAGES,
  PICTURE_WORDS_PER_PAGE,
} from '../config.ts';
import type { DB } from '../db/database.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';
import type { Sources } from '../sources/index.ts';
import {
  SourceError,
  type SourceAdapter,
  type SourceName,
  type SourceRecord,
} from '../sources/types.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import type { ParsedName } from './filename.ts';
import { refreshPrimary } from './items.ts';
import { kindFromEvidence, looksLikeReference, techTitle } from './kinds.ts';
import {
  buildQuery,
  decide,
  decideRanked,
  MATCH_VERSION,
  rankCandidates,
  type Decision,
  type MatchEvidence,
  type MatchFacts,
  type ScoredCandidate,
} from './match.ts';
import { addSameMatchSuggestions } from './reconcile.ts';
import { syncSeries } from './series.ts';
import { publicationPending, publicationSeries, refreshPublications } from '../lib/publications.ts';
import { suggestCoverageFromSources } from '../lib/coverage.ts';
import { retryAt } from '../lib/refresh.ts';

/**
 * Lookups (PLAN.md §12.1, §11.2): for each item, ask the sources for its kind, score the
 * candidates, keep them, and decide the item's identity. Resumable per item and source;
 * failures are retried on the next run; a transient failure never erases good data.
 * Owner decisions (a confirmed match, "leave unidentified", rejected candidates) always win.
 */

const KEEP_CANDIDATES = 5;
/** Candidates below this aren't worth showing in review. */
const MIN_KEPT_SCORE = 0.3;

interface FactsRow {
  id: string;
  identifiers: string;
  title: string;
  title_source: string | null;
  creators: string;
  series_hint: string | null;
  volume_label: string | null;
  issue_label: string | null;
  kind: string | null;
  title_override: string | null;
  kind_override: string | null;
}

export function matchFactsFor(db: DB, itemId: string): MatchFacts | null {
  const i = db
    .prepare(
      `SELECT i.id, i.title, i.title_source, i.creators, i.series_hint, i.volume_label,
         i.issue_label, i.kind, i.identifiers, u.title_override, u.kind_override
       FROM items i LEFT JOIN user_item u ON u.item_id = i.id WHERE i.id = ?`,
    )
    .get(itemId) as FactsRow | undefined;
  if (!i) return null;
  const files = db
    .prepare(
      `SELECT f.metadata, f.parsed, f.rel_dir, x.is_primary FROM files f
       JOIN item_files x ON x.file_id = f.id
       WHERE x.item_id = ? ORDER BY x.is_primary DESC`,
    )
    .all(itemId) as {
    metadata: string | null;
    parsed: string;
    rel_dir: string | null;
    is_primary: number;
  }[];
  const isbns = new Set<string>();
  const candidates = new Set<string>();
  for (const f of files) {
    const md = parseJson<EmbeddedMetadata | null>(f.metadata, null);
    for (const id of md?.identifiers ?? [])
      if (/isbn/i.test(id.scheme) || /^(97[89])?\d{9}[\dXx]$/.test(id.value.replace(/-/g, '')))
        isbns.add(id.value.replace(/[^0-9Xx]/g, ''));
    for (const c of md?.isbnCandidates ?? []) candidates.add(c);
  }
  // Identifiers typed in or imported for a book with no files (a store title): as strong as
  // an EPUB's own.
  const own = parseJson<{ isbn?: string[] }>(i.identifiers, {});
  for (const x of own.isbn ?? []) isbns.add(x.replace(/[^0-9Xx]/g, ''));
  const parse = parseJson<ParsedName | null>(files[0]?.parsed, null);
  const years = new Set<number>();
  for (const y of [parse?.year?.value, parse?.startYear?.value])
    if (typeof y === 'number') years.add(y);
  for (const f of files) {
    const comic = parseJson<EmbeddedMetadata | null>(f.metadata, null)?.comic;
    // ComicInfo's Year is the cover year; its Volume is often the run's start year ("2016").
    for (const v of [comic?.year, comic?.volume]) {
      const y = Number(v);
      if (Number.isInteger(y) && y > 1800 && y < 2200) years.add(y);
    }
  }
  // A comic's folder often names its run with a year: "Copperline (2019)". Only the folder the
  // file sits in counts; a year higher up ("Comics 2016") says less about this run.
  if (i.issue_label)
    for (const m of (files[0]?.rel_dir ?? '')
      .split('/')
      .at(-1)!
      .matchAll(/(?:^|[\s([_-])((?:19|20)\d\d)(?=$|[\s)\]_-])/g))
      years.add(Number(m[1]));
  const creators = parseJson<{ name: string; role?: string }[]>(i.creators, []);
  // The owner's own title is the best evidence there is (owner corrections win).
  const title = i.title_override ?? i.title;
  return {
    title,
    titleSource:
      i.title_override || i.title_source === 'embedded' || i.title_source === 'owner'
        ? 'embedded'
        : 'filename',
    // The filename's raw form only stands in for a title taken from the filename: when the
    // file's own metadata names the book, a differing filename is no evidence (a translation
    // saved under the original's name, for one).
    rawTitle:
      i.title_override || i.title_source === 'embedded' || i.title_source === 'owner'
        ? undefined
        : parse?.rawTitle,
    authors: creators.map((c) => c.name),
    seriesHint: i.series_hint,
    volume: i.volume_label,
    issue: i.issue_label,
    years: [...years],
    isbns: [...isbns].filter((x) => x.length === 10 || x.length === 13),
    isbnCandidates: [...candidates],
    runVolume: runVolumeOf(parse),
    kind: i.kind_override ?? i.kind,
  };
}

/**
 * The run (per comic source) that the other issues of this item's series in the same folder
 * are certainly in: matched with certainty or confirmed by the owner. A source whose sibling
 * issues point at two different runs gives no hint.
 */
/** A comic's series volume from its parsed filename ("Series v4 01" → 4), or null. */
export function runVolumeOf(parse: ParsedName | null): number | null {
  const v = parse?.seriesVolume?.value;
  return v && /^\d{1,2}$/.test(v) ? Number(v) : null;
}

/**
 * Which run of a name a file says it is: its series volume ("v4") and a start year joined to
 * the name ("rai1992"). Files of one series in one folder share a run only when these agree:
 * "Series 01", "Series v2 01" and "Series v4 01" side by side are three runs.
 */
export function runKeyOf(parsed: string | null): string {
  const p = parseJson<ParsedName | null>(parsed, null);
  return `${runVolumeOf(p) ?? ''}|${p?.startYear?.value ?? ''}`;
}

export function runHintsFor(db: DB, itemId: string): { source: string; id: string }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT o.match_source AS source, json_extract(m.data, '$.series.id') AS id,
         fi.parsed AS mine, fo.parsed AS theirs
       FROM items i
       JOIN item_files xi ON xi.item_id = i.id AND xi.is_primary = 1
       JOIN files fi ON fi.id = xi.file_id
       JOIN files fo ON fo.folder_id = fi.folder_id AND fo.rel_dir = fi.rel_dir AND fo.id != fi.id
       JOIN item_files xo ON xo.file_id = fo.id AND xo.is_primary = 1
       JOIN items o ON o.id = xo.item_id AND o.id != i.id
       JOIN item_matches m ON m.item_id = o.id AND m.source = o.match_source
         AND m.source_id = o.match_source_id
       WHERE i.id = ? AND i.series_hint IS NOT NULL AND o.identity = 'accepted'
         AND o.match_source IN ('metron', 'comicvine')
         AND lower(o.series_hint) = lower(i.series_hint)`,
    )
    .all(itemId) as {
    source: string;
    id: string | number | null;
    mine: string | null;
    theirs: string | null;
  }[];
  const bySource = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.id === null || runKeyOf(r.mine) !== runKeyOf(r.theirs)) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, new Set());
    bySource.get(r.source)!.add(String(r.id));
  }
  return [...bySource]
    .filter(([, ids]) => ids.size === 1)
    .map(([source, ids]) => ({ source, id: [...ids][0]! }));
}

/**
 * Comic issues left tied or unconfirmed, now that other issues in their folders are settled:
 * scored again with the run hint, from the cache (no new requests unless something was never
 * fetched). Run after each lookup run and after the owner confirms an issue.
 */
export async function resolveRunTies(
  db: DB,
  sources: Sources,
  onlyIds?: string[],
): Promise<number> {
  let changed = 0;
  for (let pass = 0; pass < 2; pass++) {
    const ids = (
      db
        .prepare(
          `SELECT i.id FROM items i WHERE i.issue_label IS NOT NULL
             AND i.identity IN ('tie', 'provisional')
             AND EXISTS (SELECT 1 FROM lookup_state l WHERE l.item_id = i.id
               AND l.source IN ('metron', 'comicvine') AND l.outcome != 'failed')`,
        )
        .pluck()
        .all() as string[]
    ).filter((id) => (!onlyIds || onlyIds.includes(id)) && runHintsFor(db, id).length > 0);
    let passChanged = 0;
    for (const id of ids) {
      const before = db.prepare('SELECT identity FROM items WHERE id = ?').pluck().get(id);
      try {
        await lookUpOnce(db, sources, id, {});
      } catch {
        continue;
      }
      if (db.prepare('SELECT identity FROM items WHERE id = ?').pluck().get(id) !== before)
        passChanged++;
    }
    changed += passChanged;
    if (passChanged === 0) break;
  }
  return changed;
}

function rejectedFor(db: DB, itemId: string): Set<string> {
  return new Set(
    (
      db
        .prepare('SELECT source, source_id FROM candidates_rejected WHERE item_id = ?')
        .all(itemId) as { source: string; source_id: string }[]
    ).map((r) => `${r.source}:${r.source_id}`),
  );
}

/**
 * Stores one source's ranked candidates for an item, replacing what it had. The owner's
 * confirmed match and the record the app remembers accepting are kept even when this search
 * didn't return them (fresh data replaces theirs when it did): a lookup never undoes either.
 */
export function storeCandidates(
  db: DB,
  itemId: string,
  source: SourceName,
  ranked: ScoredCandidate[],
  /** A record the owner picked: kept whatever its score (owner corrections win). */
  keep?: ScoredCandidate,
  /** The record the app accepted earlier and still keeps (stage 4). */
  remembered?: string | null,
): void {
  const now = nowIso();
  const override = db
    .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId) as string | null | undefined;
  const keepIds = [
    override?.startsWith(`${source}:`) ? override.slice(source.length + 1) : null,
    remembered ?? null,
  ].filter((x, i, a): x is string => x !== null && a.indexOf(x) === i);
  const old = db.prepare(
    'SELECT * FROM item_matches WHERE item_id = ? AND source = ? AND source_id = ?',
  );
  const held = keepIds
    .map(
      (id) =>
        old.get(itemId, source, id) as
          | { source_id: string; score: number; evidence: string; data: string; fetched_at: string }
          | undefined,
    )
    .filter((x) => x !== undefined);
  db.prepare('DELETE FROM item_matches WHERE item_id = ? AND source = ?').run(itemId, source);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO item_matches (item_id, source, source_id, score, rank, evidence, data, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const auto = ranked
    .filter((c) => c.score >= MIN_KEPT_SCORE && c.record.sourceId !== keep?.record.sourceId)
    .slice(0, keep ? KEEP_CANDIDATES - 1 : KEEP_CANDIDATES);
  const all = keep ? [keep, ...auto] : auto;
  // A kept record this answer did return, but below the cut: stored with its fresh data.
  for (const id of keepIds)
    if (!all.some((c) => c.record.sourceId === id)) {
      const fresh = ranked.find((c) => c.record.sourceId === id);
      if (fresh) all.push(fresh);
    }
  all.forEach((c, i) =>
    ins.run(
      itemId,
      source,
      c.record.sourceId,
      c.score,
      i + 1,
      JSON.stringify(c.evidence),
      JSON.stringify(c.record),
      now,
    ),
  );
  let rank = all.length;
  for (const h of held)
    if (!all.some((c) => c.record.sourceId === h.source_id))
      ins.run(itemId, source, h.source_id, h.score, ++rank, h.evidence, h.data, h.fetched_at);
}

export interface MatchRow {
  source: SourceName;
  sourceId: string;
  score: number;
  rank: number;
  evidence: MatchEvidence;
  record: SourceRecord;
  /**
   * The record the app accepted for this source earlier and keeps (stage 4): its decision stays
   * "accepted" whatever a later lookup ranks first, until "Look up again" releases it.
   */
  remembered?: boolean;
}

interface MatchDbRow {
  item_id: string;
  source: SourceName;
  source_id: string;
  score: number;
  rank: number;
  evidence: string;
  data: string;
  remembered?: number | null;
}

/** item_matches with whether each row is the app's remembered choice for its source. */
const MATCHES_SQL = `SELECT m.*, (l.accepted_source_id = m.source_id) AS remembered
  FROM item_matches m LEFT JOIN lookup_state l ON l.item_id = m.item_id AND l.source = m.source`;

function toMatchRow(r: MatchDbRow): MatchRow {
  return {
    ...(r.remembered === 1 ? { remembered: true } : {}),
    source: r.source,
    sourceId: r.source_id,
    score: r.score,
    rank: r.rank,
    evidence: parseJson<MatchEvidence>(r.evidence, {
      title: 0,
      author: 'unknown',
      isbn: 'none',
      notes: [],
    }),
    record: parseJson<SourceRecord>(r.data, {
      source: r.source,
      sourceId: r.source_id,
      title: '',
      authors: [],
      isbns: [],
      subjects: [],
    }),
  };
}

export function matchesOf(db: DB, itemId: string): MatchRow[] {
  return (
    db
      .prepare(`${MATCHES_SQL} WHERE m.item_id = ? ORDER BY m.source, m.rank`)
      .all(itemId) as MatchDbRow[]
  ).map(toMatchRow);
}

/** Every item's candidates, rejections and confirmed match, in three queries (for ranking). */
export function allMatchInputs(db: DB): {
  matches: Map<string, MatchRow[]>;
  rejected: Map<string, Set<string>>;
  overrides: Map<string, string>;
} {
  const matches = new Map<string, MatchRow[]>();
  for (const r of db
    .prepare(`${MATCHES_SQL} ORDER BY m.item_id, m.source, m.rank`)
    .all() as MatchDbRow[]) {
    if (!matches.has(r.item_id)) matches.set(r.item_id, []);
    matches.get(r.item_id)!.push(toMatchRow(r));
  }
  const rejected = new Map<string, Set<string>>();
  for (const r of db.prepare('SELECT * FROM candidates_rejected').all() as {
    item_id: string;
    source: string;
    source_id: string;
  }[]) {
    if (!rejected.has(r.item_id)) rejected.set(r.item_id, new Set());
    rejected.get(r.item_id)!.add(`${r.source}:${r.source_id}`);
  }
  const overrides = new Map(
    (
      db
        .prepare('SELECT item_id, match_override FROM user_item WHERE match_override IS NOT NULL')
        .all() as { item_id: string; match_override: string }[]
    ).map((r) => [r.item_id, r.match_override]),
  );
  return { matches, rejected, overrides };
}

const DECISION_ORDER: Record<Decision, number> = {
  accepted: 0,
  provisional: 1,
  tie: 2,
  unidentified: 3,
};

/**
 * Per source: the decision and the chosen candidate, honouring the owner's rejections. A record
 * the app remembers accepting stays the accepted one (stage 4); a rival that now ranks higher
 * is listed in Needs review instead of replacing it.
 */
export function decisionsFor(
  matches: MatchRow[],
  rejected: Set<string>,
): Map<SourceName, { decision: Decision; best: MatchRow | null }> {
  const bySource = new Map<SourceName, MatchRow[]>();
  for (const m of matches) {
    if (rejected.has(`${m.source}:${m.sourceId}`)) continue;
    if (!bySource.has(m.source)) bySource.set(m.source, []);
    bySource.get(m.source)!.push(m);
  }
  const out = new Map<SourceName, { decision: Decision; best: MatchRow | null }>();
  for (const [source, rows] of bySource) {
    const remembered = rows.find((r) => r.remembered);
    if (remembered) {
      out.set(source, { decision: 'accepted', best: remembered });
      continue;
    }
    const ranked = rankCandidates(
      rows.map((r) => ({ record: r.record, score: r.score, evidence: r.evidence })),
    );
    const d = decideRanked(ranked);
    const best = d.best ? (rows.find((r) => r.record === d.best!.record) ?? null) : null;
    out.set(source, { decision: d.decision, best });
  }
  return out;
}

/**
 * Recomputes an item's identity from its stored candidates (§11.2): the owner's confirmed
 * match first; "leave unidentified" if the owner said so; otherwise the best decision across
 * sources. Also refreshes the facts that follow from it (kind, reference, publication year).
 */
export function applyIdentity(db: DB, itemId: string): void {
  const override = db
    .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId) as string | null | undefined;
  const matches = matchesOf(db, itemId);
  let identity: Decision = 'unidentified';
  let chosen: MatchRow | null = null;
  let score: number | null = null;
  if (override && override !== 'none') {
    chosen = matches.find((m) => `${m.source}:${m.sourceId}` === override) ?? null;
    identity = chosen ? 'accepted' : 'unidentified';
    score = chosen?.score ?? null;
  } else if (override !== 'none') {
    const decisions = [...decisionsFor(matches, rejectedFor(db, itemId)).values()].sort(
      (a, b) =>
        DECISION_ORDER[a.decision] - DECISION_ORDER[b.decision] ||
        (b.best?.score ?? 0) - (a.best?.score ?? 0),
    );
    const top = decisions[0];
    if (top) {
      identity = top.decision;
      chosen = top.best;
      score = top.best?.score ?? null;
    }
  }
  db.prepare(
    `UPDATE items SET identity = ?, identity_score = ?, match_source = ?, match_source_id = ?,
       updated_at = ? WHERE id = ?`,
  ).run(identity, score, chosen?.source ?? null, chosen?.sourceId ?? null, nowIso(), itemId);
  refreshDerivedFacts(db, [itemId]);
}

export function mostlyPictures(words: number | null, pages: number | null): boolean {
  return (
    !!pages &&
    pages >= PICTURE_MIN_PAGES &&
    words !== null &&
    words / pages < PICTURE_WORDS_PER_PAGE
  );
}

interface FileCounts {
  metadata: string | null;
  format: string;
  word_count: number | null;
  page_count: number | null;
  size: number;
  is_primary: number;
}

/**
 * An EPUB with fewer than this many words per megabyte is page images (a fixed-layout comic):
 * prose EPUBs carry tens of thousands of words per megabyte; an image EPUB of 50 MB had 128.
 */
const EPUB_PICTURE_WORDS_PER_MB = 200;
const EPUB_PICTURE_MIN_BYTES = 2 * 1024 ** 2;

/** Is this file mostly pictures? A PDF by words per page, an EPUB by words per megabyte. */
export function picturesFile(
  f: Pick<FileCounts, 'format' | 'word_count' | 'page_count' | 'size'>,
): boolean {
  if (f.format === 'pdf') return mostlyPictures(f.word_count, f.page_count);
  if (f.format === 'epub')
    return (
      f.word_count !== null &&
      f.size >= EPUB_PICTURE_MIN_BYTES &&
      f.word_count / (f.size / 1024 ** 2) < EPUB_PICTURE_WORDS_PER_MB
    );
  return false;
}

/** Kind sources that come from the files themselves (identify/items.ts); these always win. */
// Kinds that come from the thing itself, not a guess: a file's format or its own metadata, or
// (for an entry marked read elsewhere) the series it was added to.
const FILE_KINDS = new Set(['format', 'pdf_type', 'comicinfo', 'series']);

/**
 * Facts that follow from the matches: a kind when the files don't say (§8), the reference
 * flag from title words, and the first publication year. Only facts change; the owner's
 * overrides live in user_item and win at display time.
 */
export function refreshDerivedFacts(db: DB, itemIds: string[]): void {
  const item = db.prepare(
    'SELECT id, title, kind, kind_source, match_source, identity, issue_label FROM items WHERE id = ?',
  );
  const filesOf = db.prepare(
    `SELECT f.metadata, f.format, f.word_count, f.page_count, f.size, x.is_primary FROM files f
     JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ? ORDER BY x.is_primary DESC`,
  );
  const update = db.prepare(
    `UPDATE items SET kind = @kind, kind_source = @kindSource, is_reference = @ref,
       publication_year = @year
     WHERE id = @id AND (kind IS NOT @kind OR kind_source IS NOT @kindSource
       OR is_reference IS NOT @ref OR publication_year IS NOT @year)`,
  );
  for (const id of itemIds) {
    const i = item.get(id) as
      | {
          id: string;
          title: string;
          kind: string | null;
          kind_source: string | null;
          match_source: string | null;
          identity: string;
          issue_label: string | null;
        }
      | undefined;
    if (!i) continue;
    const used = usedMatches(db, id);
    const files = filesOf.all(id) as FileCounts[];
    const p = files[0];
    const md = parseJson<EmbeddedMetadata | null>(p?.metadata ?? null, null);
    let kind = i.kind;
    let kindSource = i.kind_source;
    if (!kindSource || !FILE_KINDS.has(kindSource)) {
      const anilist = used.find((m) => m.source === 'anilist' || m.record.format === 'MANGA');
      const k = kindFromEvidence({
        subjects: used.flatMap((m) => m.record.subjects),
        anilist: anilist
          ? { format: anilist.record.format, country: anilist.record.country }
          : undefined,
        publisher: md?.publisher ?? null,
      });
      kind = k?.kind ?? null;
      kindSource = k ? `guess:${k.why}` : null;
      // A long PDF that is mostly pictures (a few words a page: credits, captions, a cover) is a
      // comic, whatever its subjects say ("Fiction" fits a graphic novel too). Manga stays manga.
      // Any copy counts: an image-only EPUB next to its PDF says the same thing.
      if (kind !== 'manga' && files.some(picturesFile)) {
        kind = 'comic';
        kindSource = 'guess:mostly pictures';
      } else if (kind === null && techTitle(i.title)) {
        kind = 'tech';
        kindSource = 'guess:programming words in its title';
      } else if (kind === null && i.issue_label) {
        // Numbered "#1" and found nowhere: comics and magazines are numbered like that, books
        // aren't. Still a guess, shown as one, and the owner's correction wins.
        kind = 'comic';
        kindSource = 'guess:numbered like a comic issue';
      }
    }
    const years = used
      .map((m) => m.record.firstPublishYear)
      .filter((y): y is number => typeof y === 'number');
    const changed = update.run({
      id,
      kind,
      kindSource,
      ref: looksLikeReference(i.title) ? 1 : 0,
      year: years.length ? Math.min(...years) : null,
    }).changes;
    // Comics and books open different formats first, so a new kind re-picks the main file.
    if (changed && kind !== i.kind) refreshPrimary(db, id);
  }
}

/**
 * The candidates whose data the app uses for an item: per source, the chosen candidate when
 * that source's decision is accepted or provisional (never a tie or a reject), and the owner's
 * confirmed match.
 */
export function usedMatches(db: DB, itemId: string): MatchRow[] {
  const override = db
    .prepare('SELECT match_override FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId) as string | null | undefined;
  return chooseUsed(matchesOf(db, itemId), override ?? null, rejectedFor(db, itemId));
}

/** Pure form of usedMatches. */
export function chooseUsed(
  matches: MatchRow[],
  override: string | null,
  rejected: Set<string>,
): MatchRow[] {
  if (override === 'none') return [];
  const decisions = [...decisionsFor(matches, rejected).values()];
  if (override) {
    const m = matches.find((x) => `${x.source}:${x.sourceId}` === override);
    // The confirmed match, plus other sources' own choices (never a tie).
    const others = decisions
      .filter((d) => d.best && d.best.source !== m?.source && d.decision !== 'tie')
      .map((d) => d.best!);
    return m ? [m, ...others] : others;
  }
  return decisions
    .filter((d) => d.best && (d.decision === 'accepted' || d.decision === 'provisional'))
    .map((d) => d.best!);
}

// ---- Running lookups ---------------------------------------------------------------------------

export interface LookupStatus {
  runId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  outcomes: Record<string, number>;
  /** Plain-language problems, newest first, at most a few. */
  errors: string[];
  /** Stopped because nothing could be reached (connection down). */
  stoppedOffline?: boolean;
  estimateSeconds: number | null;
  series?: { done: number; total: number };
  error: string | null;
  /** What kind of run: the owner's "Look up all books again", or "Refresh due books now". */
  label?: 'fresh' | 'due';
}

export interface LookupStartOptions {
  itemIds?: string[];
  /** Ignore cached answers. */
  refresh?: boolean;
  /** Let the app choose its matches again (Look up all books again). */
  fresh?: boolean;
  /** Leave paused sources paused (a run the scheduler resumes, not one the owner pressed). */
  keepBreakers?: boolean;
  label?: LookupStatus['label'];
}

/**
 * Drops candidates from sources that no longer apply to an item (the rules changed, or the
 * owner changed its kind) and re-decides its identity. Explicit sources and owner decisions stay.
 */
export function pruneInapplicable(db: DB, sources: Sources): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.item_id, l.source, COALESCE(u.kind_override, i.kind) AS kind, i.issue_label, l.manually_selected
       FROM lookup_state l JOIN items i ON i.id = l.item_id
       LEFT JOIN user_item u ON u.item_id = i.id`,
    )
    .all() as {
    item_id: string;
    source: string;
    kind: string | null;
    issue_label: string | null;
    manually_selected: number;
  }[];
  const touched = new Set<string>();
  for (const r of rows) {
    if (r.manually_selected) continue;
    if (sources.forItem(r.kind, r.issue_label).some((s) => s.name === r.source)) continue;
    db.prepare('DELETE FROM lookup_state WHERE item_id = ? AND source = ?').run(
      r.item_id,
      r.source,
    );
    // The owner's confirmed match stays, whatever the rules now say about its source.
    db.prepare(
      `DELETE FROM item_matches WHERE item_id = ? AND source = ?
         AND (source || ':' || source_id) IS NOT (SELECT match_override FROM user_item WHERE item_id = ?)`,
    ).run(r.item_id, r.source, r.item_id);
    touched.add(r.item_id);
  }
  for (const id of touched) applyIdentity(db, id);
  return touched.size;
}

/**
 * Items that still need a lookup from at least one of their sources, most urgent first.
 * `includeFailed: false` leaves out sources whose last lookup failed: automatic refresh retries
 * those on their own schedule (1, 3, 7 days), not every few minutes.
 */
export function itemsNeedingLookup(
  db: DB,
  sources: Sources,
  refresh = false,
  includeFailed = true,
): string[] {
  const rows = db
    .prepare(
      `SELECT i.id, COALESCE(u.kind_override, i.kind) AS kind, i.issue_label, u.match_override,
         u.progress, u.shortlist_position
       FROM items i LEFT JOIN user_item u ON u.item_id = i.id
       ORDER BY (u.shortlist_position IS NULL), (COALESCE(u.progress, 'not_started') IN ('not_started', 'finished', 'dnf')), i.title`,
    )
    .all() as {
    id: string;
    kind: string | null;
    issue_label: string | null;
    match_override: string | null;
  }[];
  const state = db.prepare(
    'SELECT version, query, outcome FROM lookup_state WHERE item_id = ? AND source = ?',
  );
  const out: string[] = [];
  for (const r of rows) {
    const srcs = sources.forItem(r.kind, r.issue_label);
    if (srcs.length === 0) continue;
    if (refresh) {
      out.push(r.id);
      continue;
    }
    const facts = matchFactsFor(db, r.id);
    if (!facts) continue;
    const q = JSON.stringify(buildQuery(facts));
    const needs = srcs.some((s) => {
      const st = state.get(r.id, s.name) as
        { version: number; query: string; outcome: string } | undefined;
      if (!st) return true;
      if (st.outcome === 'failed') return includeFailed;
      return st.version !== MATCH_VERSION || st.query !== q;
    });
    if (needs) out.push(r.id);
  }
  return out;
}

export interface LookupOptions {
  /** Ignore cached answers: ask the sources again. */
  refresh?: boolean;
  /**
   * Start fresh (the owner's "Look up again"): a source that answers lets the app choose its
   * match again, releasing the one it remembered. Confirmed matches and rejections stay.
   */
  fresh?: boolean;
  /** An automatic refresh: an empty or unclear answer keeps the previous result. */
  background?: boolean;
  /** Ask only these sources (automatic refresh asks the ones that are due). */
  only?: SourceName[];
  /** Explicit manual choice, independent of the automatic source plan. */
  source?: SourceName;
}

export interface LookupResult {
  source: SourceName;
  outcome: string;
  error?: string;
  /** The source's daily allowance ran out (not this book's fault). */
  quota?: boolean;
}

const COMIC_SOURCES: SourceName[] = ['metron', 'comicvine'];

/**
 * The sources to ask for an item: with `only`, exactly those and no others. A caller that wants
 * ComicVine's fallback after Metron passes both (`withComicPartners`); one that left a source
 * out (its allowance is used up) keeps it out.
 */
function askedSources(
  sources: Sources,
  kind: string | null,
  issue: string | null,
  only?: SourceName[],
  source?: SourceName,
): SourceAdapter[] {
  if (source) return sources.onlineSources().filter((s) => s.name === source);
  const all = sources.forItem(kind, issue);
  return only ? all.filter((s) => only.includes(s.name)) : all;
}

/**
 * Metron and ComicVine are asked together (ComicVine only when Metron finds nothing), so a due
 * comic source brings its partner, from the sources this item uses.
 */
export function withComicPartners(wanted: SourceName[], itemSources: SourceName[]): SourceName[] {
  if (!wanted.some((s) => COMIC_SOURCES.includes(s))) return wanted;
  return [...new Set([...wanted, ...itemSources.filter((s) => COMIC_SOURCES.includes(s))])];
}

/**
 * Looks one item up in every source for it. What a lookup finds can change the item's guessed
 * kind (a "book" whose subjects say graphic novel becomes a comic), and the kind changes how it
 * is searched (series + volume number) and which sources apply (manga adds AniList). So when the
 * search changed, the item is looked up again at once — at most MAX_PASSES times — and then
 * marked settled with its current search, so it can never come back run after run. (Seen on the
 * owner's PC: 131, then 76, books "not looked up" after runs with no failures.)
 */
const MAX_PASSES = 2;

export async function lookUpItem(
  db: DB,
  sources: Sources,
  itemId: string,
  opts: LookupOptions = {},
): Promise<LookupResult[]> {
  let results: LookupResult[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    results = await lookUpOnce(db, sources, itemId, opts);
    // Preserve explicitly requested results across bulk cleanup, including a failed refresh
    // that kept an earlier answer. Automatic upserts leave this owner-intent flag alone.
    if (opts.source)
      db.prepare(
        'UPDATE lookup_state SET manually_selected = 1 WHERE item_id = ? AND source = ?',
      ).run(itemId, opts.source);
    if (results.some((r) => r.outcome === 'failed')) return results;
    if (!searchChanged(db, sources, itemId, opts.only, opts.source)) return results;
  }
  // Still changing: settle on the current search, so the next run doesn't ask again.
  const facts = matchFactsFor(db, itemId);
  if (facts) {
    const qKey = JSON.stringify(buildQuery(facts));
    const now = nowIso();
    for (const s of askedSources(sources, facts.kind, facts.issue ?? null, opts.only, opts.source))
      db.prepare(
        `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome, error, last_answer_at)
         VALUES (?, ?, ?, ?, ?, 'none', NULL, ?)
         ON CONFLICT (item_id, source) DO UPDATE SET version = excluded.version,
           query = excluded.query`,
      ).run(itemId, s.name, MATCH_VERSION, qKey, now, now);
  }
  return results;
}

/** Would the item be searched differently now, or by a source not asked yet? */
function searchChanged(
  db: DB,
  sources: Sources,
  itemId: string,
  only?: SourceName[],
  source?: SourceName,
): boolean {
  const facts = matchFactsFor(db, itemId);
  if (!facts) return false;
  const qKey = JSON.stringify(buildQuery(facts));
  const state = db.prepare('SELECT query FROM lookup_state WHERE item_id = ? AND source = ?');
  return askedSources(sources, facts.kind, facts.issue ?? null, only, source).some((s) => {
    const st = state.get(itemId, s.name) as { query: string } | undefined;
    return !st || st.query !== qKey;
  });
}

/** One lookup_state row, as stored. */
export interface LookupStateRow {
  item_id: string;
  source: SourceName;
  version: number;
  query: string;
  looked_up_at: string;
  outcome: string;
  error: string | null;
  accepted_source_id: string | null;
  rival_source_id: string | null;
  last_answer_at: string | null;
  next_eligible_at: string | null;
  failure_count: number;
}

function writeState(db: DB, row: LookupStateRow): void {
  db.prepare(
    `INSERT INTO lookup_state (item_id, source, version, query, looked_up_at, outcome, error,
       accepted_source_id, rival_source_id, last_answer_at, next_eligible_at, failure_count)
     VALUES (@item_id, @source, @version, @query, @looked_up_at, @outcome, @error,
       @accepted_source_id, @rival_source_id, @last_answer_at, @next_eligible_at, @failure_count)
     ON CONFLICT (item_id, source) DO UPDATE SET version = excluded.version,
       query = excluded.query, looked_up_at = excluded.looked_up_at, outcome = excluded.outcome,
       error = excluded.error, accepted_source_id = excluded.accepted_source_id,
       rival_source_id = excluded.rival_source_id, last_answer_at = excluded.last_answer_at,
       next_eligible_at = excluded.next_eligible_at, failure_count = excluded.failure_count`,
  ).run(row);
}

/** The next local midnight: a source whose daily allowance ran out is asked again then. */
export function nextLocalDay(now = new Date()): string {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

export const KEPT_PREVIOUS =
  'The latest answer didn’t clearly find this book, so the previous result is kept.';

async function lookUpOnce(
  db: DB,
  sources: Sources,
  itemId: string,
  opts: LookupOptions,
): Promise<LookupResult[]> {
  const facts = matchFactsFor(db, itemId);
  if (!facts) return [];
  if (facts.issue) facts.runs = runHintsFor(db, itemId);
  const query = buildQuery(facts);
  const qKey = JSON.stringify(query);
  const results: LookupResult[] = [];
  const all = askedSources(sources, facts.kind, facts.issue ?? null, opts.only, opts.source);
  // Real requests per source before asking: an answer counts as "the source answered" only
  // when a request went out (a re-read of the cache is not news from the source).
  const before = new Map(all.map((s) => [s.name, sources.requestCount(s.name)]));
  const rejectedBefore = rejectedFor(db, itemId);
  const ask = (list: SourceAdapter[]) =>
    Promise.allSettled(
      list.map(async (s: SourceAdapter) => {
        let records = await s.search(query, opts);
        // A run-together filename title that found nothing: try the raw form too (§11.1).
        if (records.length === 0 && query.rawTitle)
          records = await s.search({ ...query, title: query.rawTitle }, opts);
        // Opening-page ISBNs are leads, not authoritative identifiers. Search them only
        // when title matching is unresolved, then score against the original file facts.
        // A lead that fails (offline, rate limit) only loses that lead: the title answer stays.
        // A printed ISBN's answer hardly changes, so a cached one is used even on a refresh.
        if (
          s.name === 'openlibrary' &&
          !query.isbn &&
          decide(facts, records, rejectedBefore).decision !== 'accepted'
        ) {
          for (const isbn of facts.isbnCandidates.slice(0, ISBN_LEAD_SEARCHES)) {
            let extra: SourceRecord[];
            try {
              extra = await s.search({ ...query, isbn }, { ...opts, refresh: false });
            } catch {
              break;
            }
            const seen = new Set(records.map((r) => r.sourceId));
            records = [...records, ...extra.filter((r) => !seen.has(r.sourceId))];
            if (decide(facts, records, rejectedBefore).decision === 'accepted') break;
          }
        }
        return { s, records };
      }),
    );
  const settled = await ask(all.filter((s) => !s.fallback));
  // A fallback source (ComicVine) is asked only when nothing else found a usable match, or
  // couldn't be asked. Otherwise its lookup is recorded as skipped: its allowance is small.
  const rejectedNow = rejectedFor(db, itemId);
  const foundElsewhere = settled.some(
    (r) =>
      r.status === 'fulfilled' &&
      decide(facts, r.value.records, rejectedNow).decision !== 'unidentified',
  );
  const fallbacks = all.filter((s) => s.fallback);
  const skipped = foundElsewhere ? fallbacks : [];
  if (!foundElsewhere) settled.push(...(await ask(fallbacks)));
  // A merge may retire this id while a source request is waiting. A correction or split
  // may also change its search. Discard the old result; the next pass can use current facts.
  const currentFacts = matchFactsFor(db, itemId);
  if (!currentFacts || JSON.stringify(buildQuery(currentFacts)) !== qKey) return [];
  const state = db.prepare('SELECT * FROM lookup_state WHERE item_id = ? AND source = ?');
  db.transaction(() => {
    const now = nowIso();
    const rejected = rejectedFor(db, itemId);
    const stored = matchesOf(db, itemId);
    const present = new Set(stored.map((m) => `${m.source}:${m.sourceId}`));
    // What each source's stored candidates still give, whatever the last lookup's outcome (a
    // failed lookup keeps them, so "failed" can sit on top of a good match).
    const held = decisionsFor(stored, rejected);
    const blank = (source: SourceName): LookupStateRow => ({
      item_id: itemId,
      source,
      version: MATCH_VERSION,
      query: qKey,
      looked_up_at: now,
      outcome: 'none',
      error: null,
      accepted_source_id: null,
      rival_source_id: null,
      last_answer_at: null,
      next_eligible_at: null,
      failure_count: 0,
    });
    // A remembered choice belongs to the search that made it: once the search changes (the owner
    // corrected the title, say), it is released even when this source didn't answer, or a later
    // retry with the same new search would keep the old book.
    const sameSearch = (prev: LookupStateRow | undefined) =>
      prev?.query === qKey ? {} : { accepted_source_id: null, rival_source_id: null };
    for (const r of settled) {
      if (r.status === 'rejected') {
        const e = r.reason as Error;
        const source = e instanceof SourceError ? e.source : 'openlibrary';
        const quota = e instanceof SourceError && e.quota;
        const prev = state.get(itemId, source) as LookupStateRow | undefined;
        // Keep the candidates (and the remembered choice) we had: a failure never erases good
        // data. Retries back off; a used-up allowance waits for the next day instead.
        const failures = (prev?.failure_count ?? 0) + (quota ? 0 : 1);
        writeState(db, {
          ...blank(source),
          ...(prev ?? {}),
          ...sameSearch(prev),
          version: MATCH_VERSION,
          query: qKey,
          looked_up_at: now,
          outcome: 'failed',
          error: e.message,
          failure_count: failures,
          next_eligible_at: quota ? nextLocalDay() : retryAt(itemId, source, failures, now),
        });
        results.push({ source, outcome: 'failed', error: e.message, quota });
        continue;
      }
      const { s, records } = r.value;
      const prev = state.get(itemId, s.name) as LookupStateRow | undefined;
      const answered = sources.demo || sources.requestCount(s.name) > (before.get(s.name) ?? 0);
      const answerAt = answered ? now : (prev?.last_answer_at ?? now);
      const d = decide(facts, records, rejected);
      // An automatic refresh that no longer finds the book clearly keeps what it had, and
      // tries again sooner (a site hiccup shouldn't take a book's rating away).
      const had = held.get(s.name)?.decision;
      if (
        opts.background &&
        prev &&
        (d.decision === 'unidentified' || d.decision === 'tie') &&
        (had === 'accepted' || had === 'provisional')
      ) {
        const failures = prev.failure_count + 1;
        const outcome = had === 'accepted' ? 'matched' : 'provisional';
        writeState(db, {
          ...prev,
          looked_up_at: now,
          outcome,
          error: KEPT_PREVIOUS,
          last_answer_at: answerAt,
          failure_count: failures,
          next_eligible_at: retryAt(itemId, s.name, failures, now),
        });
        results.push({ source: s.name, outcome, error: KEPT_PREVIOUS });
        continue;
      }
      // The app's earlier choice stays unless the owner asked to start fresh, the search itself
      // changed (the owner corrected the title, say), or the owner rejected it.
      const was = prev?.accepted_source_id ?? null;
      const kept =
        was &&
        !opts.fresh &&
        prev?.query === qKey &&
        !rejected.has(`${s.name}:${was}`) &&
        present.has(`${s.name}:${was}`)
          ? was
          : null;
      let accepted = kept;
      let rival: string | null = null;
      if (d.decision === 'accepted' && d.best) {
        if (!accepted) accepted = d.best.record.sourceId;
        else if (d.best.record.sourceId !== accepted) rival = d.best.record.sourceId;
      }
      storeCandidates(db, itemId, s.name, d.ranked, undefined, accepted);
      const outcome = accepted
        ? 'matched'
        : d.decision === 'unidentified'
          ? 'none'
          : d.decision === 'accepted'
            ? 'matched'
            : d.decision;
      writeState(db, {
        ...blank(s.name),
        outcome,
        accepted_source_id: accepted,
        rival_source_id: rival,
        last_answer_at: answerAt,
      });
      results.push({ source: s.name, outcome });
    }
    for (const s of skipped) {
      const prev = state.get(itemId, s.name) as LookupStateRow | undefined;
      writeState(db, {
        ...blank(s.name),
        ...(prev ?? {}),
        ...sameSearch(prev),
        version: MATCH_VERSION,
        query: qKey,
        looked_up_at: now,
        outcome: 'skipped',
        error: null,
        last_answer_at: prev?.last_answer_at ?? now,
        next_eligible_at: null,
        failure_count: 0,
      });
      results.push({ source: s.name, outcome: 'skipped' });
    }
    applyIdentity(db, itemId);
  })();
  return results;
}

/**
 * Fills the stage-4 columns for lookups made before them: when the source last answered (taken
 * from when it was last looked up) and the record the app accepted then, so a later refresh
 * keeps it. Only rows never written by the new code are touched, so this is safe to run at
 * every start and after a restore.
 */
export function prepareRefreshState(db: DB): number {
  // A failed latest lookup keeps the candidates from before it, so its row may still hold an
  // accepted match to remember; it has no known answer time, though, so that stays empty.
  const rows = db
    .prepare(
      `SELECT item_id, source, outcome FROM lookup_state
       WHERE last_answer_at IS NULL AND accepted_source_id IS NULL`,
    )
    .all() as { item_id: string; source: SourceName; outcome: string }[];
  if (rows.length === 0) return 0;
  const byItem = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id)!.push(r);
  }
  const setAnswer = db.prepare(
    'UPDATE lookup_state SET last_answer_at = looked_up_at WHERE item_id = ? AND source = ?',
  );
  const setAccepted = db.prepare(
    `UPDATE lookup_state SET accepted_source_id = ?
     WHERE item_id = ? AND source = ? AND accepted_source_id IS NULL`,
  );
  db.transaction(() => {
    for (const [itemId, rs] of byItem) {
      const decisions = decisionsFor(matchesOf(db, itemId), rejectedFor(db, itemId));
      for (const r of rs) {
        if (r.outcome !== 'failed') setAnswer.run(itemId, r.source);
        const d = decisions.get(r.source);
        if (d?.decision === 'accepted' && d.best)
          setAccepted.run(d.best.sourceId, itemId, r.source);
      }
    }
  })();
  return rows.length;
}

/** One lookup run at a time; cancellable; progress saved per item (§9.6). */
export class LookupManager {
  private current: LookupStatus | null = null;
  private cancelled = false;
  private running: Promise<void> | null = null;
  private readonly db: DB;
  private readonly sources: Sources;
  private pendingCache: { n: number; series: number; at: number } | null = null;
  /** Stops background refresh work and waits for it, before a run starts. */
  private stopBackground: (() => Promise<void>) | null = null;
  /** Called when a run ends (the scheduler keeps "Look up all books again" going). */
  afterRun: ((s: LookupStatus) => void) | null = null;

  constructor(db: DB, sources: Sources) {
    this.db = db;
    this.sources = sources;
  }

  isRunning(): boolean {
    return this.current?.status === 'running';
  }

  status(): LookupStatus | null {
    if (this.current) return this.current;
    const last = this.db
      .prepare('SELECT summary FROM enrich_runs ORDER BY started_at DESC LIMIT 1')
      .pluck()
      .get() as string | undefined;
    const saved = last ? parseJson<LookupStatus | null>(last, null) : null;
    // Older summaries lack errors; an interrupted run may leave the default empty object.
    if (!saved?.status) return null;
    return { ...saved, errors: saved.errors ?? [] };
  }

  /**
   * Books still to look up. Working it out reads every item's facts (about 0.4 s for 5,000
   * items), and pages ask on every load, so the answer is kept for half a minute and dropped
   * whenever a lookup run or a scan ends.
   */
  pending(): number {
    if (this.pendingCache && Date.now() - this.pendingCache.at < 30_000) return this.pendingCache.n;
    const n = itemsNeedingLookup(this.db, this.sources).length;
    const series = publicationSeries(this.db, this.sources).filter((id) =>
      publicationPending(this.db, id),
    ).length;
    this.pendingCache = { n, series, at: Date.now() };
    return n;
  }

  pendingSeries(): number {
    this.pending();
    return this.pendingCache!.series;
  }

  invalidate(): void {
    this.pendingCache = null;
  }

  /** Background refresh registers how to stop it: a lookup run never overlaps a batch. */
  setBackgroundStop(stop: () => Promise<void>): void {
    this.stopBackground = stop;
  }

  start(opts: LookupStartOptions = {}): LookupStatus {
    if (this.isRunning()) throw new HttpError(409, 'Lookups are already running.');
    // A new run the owner started begins with every source un-paused: the connection may be back.
    if (!opts.keepBreakers) this.sources.resetBreakers();
    this.db.transaction(() => {
      pruneInapplicable(this.db, this.sources);
      // Kind rules may have changed since the books were looked up; re-derive them (no requests).
      refreshDerivedFacts(
        this.db,
        this.db.prepare('SELECT id FROM items').pluck().all() as string[],
      );
      syncSeries(this.db);
    })();
    const ids = opts.itemIds ?? itemsNeedingLookup(this.db, this.sources, opts.refresh);
    const status: LookupStatus = {
      runId: newId(),
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      total: ids.length,
      done: 0,
      outcomes: {},
      errors: [],
      estimateSeconds: null,
      error: null,
      ...(opts.label ? { label: opts.label } : {}),
    };
    this.db
      .prepare("INSERT INTO enrich_runs (id, status, started_at) VALUES (?, 'running', ?)")
      .run(status.runId, status.startedAt);
    this.current = status;
    this.cancelled = false;
    const stop = this.stopBackground;
    this.running = (async () => {
      if (stop) await stop();
      await this.run(ids, status, { refresh: Boolean(opts.refresh), fresh: Boolean(opts.fresh) });
    })();
    return status;
  }

  requestCancel(): boolean {
    if (!this.isRunning()) return false;
    this.cancelled = true;
    return true;
  }

  async wait(): Promise<LookupStatus | null> {
    await this.running;
    return this.status();
  }

  async close(): Promise<void> {
    this.requestCancel();
    await this.running;
  }

  private async run(
    ids: string[],
    status: LookupStatus,
    opts: { refresh: boolean; fresh: boolean },
  ): Promise<void> {
    const refresh = opts.refresh;
    const started = Date.now();
    let failedInARow = 0;
    try {
      for (const id of ids) {
        if (this.cancelled) break;
        if (failedInARow >= LOOKUP_STOP_AFTER_FAILED_ITEMS) {
          status.stoppedOffline = true;
          break;
        }
        // The item may have been merged away or removed since the run started.
        if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) {
          status.done++;
          continue;
        }
        const results = await lookUpItem(this.db, this.sources, id, opts);
        failedInARow =
          results.length > 0 && results.every((r) => r.outcome === 'failed') ? failedInARow + 1 : 0;
        for (const r of results) {
          status.outcomes[r.outcome] = (status.outcomes[r.outcome] ?? 0) + 1;
          if (r.error) {
            const msg = `${this.sources.label(r.source)}: ${r.error}`;
            if (status.errors[0] !== msg) status.errors = [msg, ...status.errors].slice(0, 5);
          }
        }
        status.done++;
        if (status.done >= 10) {
          const per = (Date.now() - started) / status.done;
          status.estimateSeconds = Math.round((per * (status.total - status.done)) / 1000);
        }
      }
      // Issues next to ones now settled follow their run (cache only).
      if (!this.cancelled && !status.stoppedOffline) await resolveRunTies(this.db, this.sources);
      if (status.stoppedOffline) {
        status.status = 'failed';
        status.error = `Couldn’t reach the online sources for ${LOOKUP_STOP_AFTER_FAILED_ITEMS} books in a row, so the lookups stopped. Check the internet connection (or VPN), then press “Look them up now” to carry on where it stopped.`;
      } else status.status = this.cancelled ? 'cancelled' : 'completed';
    } catch (err) {
      status.status = 'failed';
      status.error = (err as Error).message;
    } finally {
      const finalStatus = status.status;
      status.status = 'running';
      // What the run learned about series (names, order, finished or ongoing) takes effect.
      try {
        syncSeries(this.db);
        if (!this.cancelled && !status.stoppedOffline) {
          const series = publicationSeries(this.db, this.sources);
          status.series = { done: 0, total: series.length };
          status.estimateSeconds = null;
          let failures = 0;
          for (const id of series) {
            if (this.cancelled || failures >= LOOKUP_STOP_AFTER_FAILED_ITEMS) break;
            try {
              await refreshPublications(this.db, this.sources, id, refresh);
              failures = 0;
            } catch (err) {
              failures++;
              status.errors = [
                `Published volumes: ${(err as Error).message}`,
                ...status.errors,
              ].slice(0, 5);
            }
            status.series.done++;
          }
        }
        // What collected editions reprint, as suggestions (§12.5).
        suggestCoverageFromSources(this.db);
        // Two entries matched to the same book are probably one book (§11.3 rule 4).
        addSameMatchSuggestions(this.db);
      } catch (err) {
        status.errors = [`Series: ${(err as Error).message}`, ...status.errors].slice(0, 5);
      }
      status.status = this.cancelled ? 'cancelled' : finalStatus;
      status.finishedAt = nowIso();
      status.estimateSeconds = null;
      this.db
        .prepare('UPDATE enrich_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?')
        .run(status.status, status.finishedAt, JSON.stringify(status), status.runId);
      this.current = null;
      this.pendingCache = null;
      try {
        this.afterRun?.(status);
      } catch (err) {
        console.error(err);
      }
    }
  }
}
