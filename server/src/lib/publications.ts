import type { DB } from '../db/database.ts';
import { MATCH_ACCEPT, SERIES_PUBLICATION_CACHE_DAYS } from '../config.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { usedMatches } from '../identify/lookups.ts';
import type { Sources } from '../sources/index.ts';
import type { PublishedVolume } from '../sources/types.ts';
import { HttpError, nowIso, parseJson, todayLocal } from '../util.ts';
import type { SeriesMember } from './series.ts';

export function volumeRanges(positions: number[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const n of [...new Set(positions)]
    .filter((p) => Number.isInteger(p) && p > 0)
    .sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && last.to + 1 === n) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

export function publicationView(db: DB, seriesId: string, members: SeriesMember[]) {
  const row = db
    .prepare(
      'SELECT source, entries, checked_at, anchor_book_id, anchor_key FROM series_publications WHERE series_id = ?',
    )
    .get(seriesId) as
    | {
        source: string;
        entries: string;
        checked_at: string;
        anchor_book_id: string;
        anchor_key: string;
      }
    | undefined;
  if (!row) return null;
  if (row.source === 'hardcover') {
    const a = anchor(db, seriesId, row.anchor_book_id);
    if (!a || anchorKey(a) !== row.anchor_key) return null;
  }
  const raw = parseJson<unknown>(row.entries, []);
  const volumes = (Array.isArray(raw) ? raw : []).filter(
    (e): e is PublishedVolume =>
      e &&
      Number.isInteger(e.position) &&
      e.position > 0 &&
      typeof e.title === 'string' &&
      typeof e.publishedOn === 'string' &&
      e.publishedOn <= todayLocal(),
  );
  const held = new Set(
    members.filter((m) => m.unit === 'volume' && m.position !== null).map((m) => m.position),
  );
  const missing = volumes.filter((v) => !held.has(v.position));
  return {
    source: row.source,
    checkedAt: row.checked_at,
    volumes,
    missing,
    missingRanges: volumeRanges(missing.map((v) => v.position)),
  };
}

function anchor(db: DB, seriesId: string, bookId?: string) {
  const rows = db
    .prepare(
      `SELECT i.id, i.series_position, s.name, u.match_override FROM items i
    JOIN series s ON s.id = i.series_id LEFT JOIN user_item u ON u.item_id = i.id
    WHERE i.series_id = ? AND i.series_unit = 'volume' ORDER BY i.series_position, i.id`,
    )
    .all(seriesId) as {
    id: string;
    series_position: number | null;
    name: string;
    match_override: string | null;
  }[];
  for (const row of rows) {
    const match = usedMatches(db, row.id).find(
      (m) =>
        m.source === 'hardcover' &&
        (!bookId || m.sourceId === bookId) &&
        (m.score >= MATCH_ACCEPT ||
          m.evidence.isbn === 'strong' ||
          row.match_override === `hardcover:${m.sourceId}`) &&
        (!m.record.series?.name ||
          titleCompareKey(m.record.series.name) === titleCompareKey(row.name)),
    );
    if (match)
      return {
        itemId: row.id,
        bookId: match.sourceId,
        position: row.series_position,
        name: row.name,
      };
  }
  return null;
}

function anchorKey(a: { name: string; position: number | null }) {
  return JSON.stringify([a.name, a.position]);
}

export function publicationPending(db: DB, seriesId: string): boolean {
  const row = db
    .prepare('SELECT checked_at FROM series_publications WHERE series_id = ?')
    .get(seriesId) as { checked_at: string } | undefined;
  const age = row ? Date.now() - Date.parse(row.checked_at) : NaN;
  return (
    !row ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > SERIES_PUBLICATION_CACHE_DAYS * 86_400_000 ||
    !publicationView(db, seriesId, [])
  );
}

export function publicationLookup(db: DB, sources: Sources, seriesId: string) {
  if (sources.demo)
    return { available: false, reason: 'The demo uses an invented published-volume catalogue.' };
  if (!sources.hardcover.configured())
    return {
      available: false,
      reason: 'Add a Hardcover token in Settings to check published volumes.',
    };
  if (!anchor(db, seriesId))
    return {
      available: false,
      reason:
        'Confirm a Hardcover match for a volume in this series to check later published volumes.',
    };
  return { available: true, reason: null };
}

/** Catalogue facts stay separate from library items and from a finished story's final length. */
export async function refreshPublications(
  db: DB,
  sources: Sources,
  seriesId: string,
  refresh = false,
): Promise<boolean> {
  const allowed = publicationLookup(db, sources, seriesId);
  if (!allowed.available) throw new HttpError(409, allowed.reason!);
  const a = anchor(db, seriesId)!;
  const old = db.prepare('SELECT 1 FROM series_publications WHERE series_id = ?').get(seriesId);
  if (!refresh && !publicationPending(db, seriesId)) return false;
  const catalogue = await sources.hardcover.publishedSeries(a.bookId, a.name, a.position, {
    refresh: refresh || Boolean(old),
  });
  // The owner may have corrected/merged the book while a polite source request was waiting.
  const current = anchor(db, seriesId);
  if (
    !current ||
    current.itemId !== a.itemId ||
    current.bookId !== a.bookId ||
    current.position !== a.position ||
    current.name !== a.name
  )
    throw new HttpError(409, 'This series changed during the lookup. Check it again.');
  db.prepare(
    `INSERT INTO series_publications (series_id, source, source_series_id, anchor_book_id, anchor_key, entries, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (series_id) DO UPDATE SET source = excluded.source,
    source_series_id = excluded.source_series_id, anchor_book_id = excluded.anchor_book_id, anchor_key = excluded.anchor_key, entries = excluded.entries, checked_at = excluded.checked_at`,
  ).run(
    seriesId,
    catalogue.source,
    catalogue.sourceSeriesId,
    a.bookId,
    anchorKey(a),
    JSON.stringify(catalogue.entries),
    nowIso(),
  );
  return true;
}

export function publicationSeries(db: DB, sources: Sources): string[] {
  if (sources.demo || !sources.hardcover.configured()) return [];
  return (
    db
      .prepare(
        "SELECT DISTINCT series_id FROM items WHERE series_id IS NOT NULL AND series_unit = 'volume'",
      )
      .pluck()
      .all() as string[]
  ).filter((id) => Boolean(anchor(db, id)));
}
