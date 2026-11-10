import type { DB } from '../db/database.ts';
import { SOURCE_LABELS } from '../sources/types.ts';
import { parseJson } from '../util.ts';
import { formatRange } from './estimate.ts';
import type { RankItem } from './recommend.ts';

/**
 * CSV export for spreadsheets (PLAN.md §16): one row per book, the owner's data beside the
 * main facts. It is not a backup — the JSON backup is — and the first line says so.
 *
 * The first columns share their names with the store CSV import (§14), so the file reads the
 * same way to a person. Cells that a spreadsheet would run as a formula (starting with = + - @,
 * or a tab or carriage return) are prefixed with an apostrophe: titles and notes come from files
 * and other people's data, and must stay text.
 */

export const EXPORT_COLUMNS = [
  'title',
  'author',
  'kind',
  'reference',
  'progress',
  'dnf_reason',
  'started_on',
  'finished_on',
  'rating',
  'triage',
  'shortlist',
  'series',
  'series_index',
  'isbn',
  'formats',
  'where',
  'stores',
  'read_elsewhere',
  'acquired_on',
  'first_published',
  'community_rating',
  'community_votes',
  'community_source',
  'estimated_length',
  'length_basis',
  'note',
  'takeaway',
  'id',
  'community_scope',
  'community_match',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A date the owner said is unknown stays empty, never a made-up one. */
const dated = (d: string | null, precision: string | null) =>
  d && precision !== 'unknown' ? d : '';

export function exportCsv(db: DB, items: RankItem[]): string {
  const stores = new Map<string, string[]>();
  for (const r of db
    .prepare("SELECT item_id, store FROM locations WHERE kind = 'store' ORDER BY created_at")
    .all() as { item_id: string; store: string | null }[]) {
    if (!stores.has(r.item_id)) stores.set(r.item_id, []);
    stores.get(r.item_id)!.push(r.store ?? 'other');
  }
  const isbns = new Map(
    (
      db.prepare('SELECT id, identifiers FROM items').all() as { id: string; identifiers: string }[]
    ).map((r) => {
      const isbn = parseJson<{ isbn?: unknown }>(r.identifiers, {}).isbn;
      return [r.id, Array.isArray(isbn) ? isbn.map(String).join(' ') : ''];
    }),
  );
  const acquired = new Map(
    (
      db.prepare('SELECT item_id, acquired_on, acquired_precision FROM user_item').all() as {
        item_id: string;
        acquired_on: string | null;
        acquired_precision: string | null;
      }[]
    ).map((r) => [r.item_id, dated(r.acquired_on, r.acquired_precision)]),
  );

  const sorted = [...items].sort(
    (a, b) =>
      a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id),
  );
  const lines = [
    // A first line a spreadsheet shows as a note above the header.
    csvCell(
      'whatBooksNext export for spreadsheets. Not a backup: use Settings → Download a backup for that.',
    ),
    EXPORT_COLUMNS.join(','),
  ];
  for (const i of sorted) {
    const u = i.user;
    const c = i.community;
    const row: Record<(typeof EXPORT_COLUMNS)[number], unknown> = {
      title: i.title,
      author: i.creators
        .map((x) => (x.role && !/author|writer/i.test(x.role) ? `${x.name} (${x.role})` : x.name))
        .join('; '),
      kind: i.kind ?? '',
      reference: i.isReference ? 'yes' : '',
      progress: u.progress,
      dnf_reason: u.dnfReason ?? '',
      started_on: dated(u.startedOn, u.startedPrecision),
      finished_on: dated(u.finishedOn, u.finishedPrecision),
      rating: u.rating ?? '',
      triage: u.triage ?? '',
      shortlist: u.shortlistPosition ?? '',
      series: i.series?.name ?? '',
      series_index: i.series?.label ?? '',
      isbn: isbns.get(i.id) ?? '',
      formats: i.formats.join(' '),
      where: i.historyOnly ? 'read elsewhere' : (i.availability.label ?? 'on this PC'),
      stores: (stores.get(i.id) ?? []).join(' '),
      read_elsewhere: i.historyOnly ? 'yes' : '',
      acquired_on: acquired.get(i.id) ?? '',
      first_published: i.firstPublishYear ?? '',
      community_rating: c ? `${c.raw}/${c.scale}` : '',
      community_votes: c?.votes ?? '',
      community_source: c ? SOURCE_LABELS[c.source] : '',
      estimated_length: i.duration ? formatRange(i.duration) : '',
      length_basis: i.duration ? `${i.duration.basis}${i.duration.measured ? '' : ' (rough)'}` : '',
      note: u.note ?? '',
      takeaway: u.takeaway ?? '',
      id: i.id,
      community_scope: c?.scope ?? '',
      community_match: c?.match ?? '',
    };
    lines.push(EXPORT_COLUMNS.map((k) => csvCell(row[k])).join(','));
  }
  // CRLF and a BOM: Excel on Windows then reads it as UTF-8 with its accents intact.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
