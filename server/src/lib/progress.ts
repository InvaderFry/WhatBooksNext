import type { DB } from '../db/database.ts';
import { HttpError, nowIso, todayLocal } from '../util.ts';

/**
 * Owner edits to one item (progress, dates, rating, notes, overrides). PLAN.md §13.6:
 *  - one-tap buckets; dates are recorded for actions taken now;
 *  - past reading keeps exact, approximate or unknown dates — never today's date as a stand-in;
 *  - "Did not finish" takes an optional reason; leaving DNF clears it.
 */

export const PROGRESS = [
  'not_started',
  'sampled',
  'into_it',
  'halfway',
  'nearly_done',
  'finished',
  'dnf',
] as const;
export const DNF_REASONS = ['not_for_me', 'not_now', 'too_difficult'] as const;
export const PRECISIONS = ['exact', 'approximate', 'unknown'] as const;
export const KINDS = ['fiction', 'nonfiction', 'self_help', 'tech', 'comic', 'manga'] as const;

export interface UserPatch {
  progress?: string;
  dnfReason?: string | null;
  startedOn?: string | null;
  startedPrecision?: string | null;
  finishedOn?: string | null;
  finishedPrecision?: string | null;
  rating?: number | null;
  note?: string | null;
  takeaway?: string | null;
  hidden?: boolean;
  titleOverride?: string | null;
  kindOverride?: string | null;
  referenceOverride?: boolean | null;
  icloudOverride?: 'in' | 'not_in' | null;
  triage?: 'want' | 'maybe' | 'never' | null;
  effortOverride?: 'light' | 'medium' | 'heavy' | null;
  /** "Use this file by default": one of the item's file ids, or null to let the app choose. */
  preferredFileId?: string | null;
  /** The series this item belongs to: a name, '' for "not part of a series", null to let the app decide. */
  seriesOverride?: string | null;
  /** Its number in the series, or null to let the app decide. */
  seriesPositionOverride?: number | null;
}

const MAX_TEXT = 10_000;

function oneOf<T extends readonly string[]>(
  name: string,
  v: unknown,
  allowed: T,
  nullable = true,
): T[number] | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(
      400,
      `${name} must be one of ${allowed.join(', ')}${nullable ? ' or null' : ''}.`,
    );
  }
  return v as T[number];
}

function text(name: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text.`);
  if (v.length > MAX_TEXT) throw new HttpError(400, `${name} is too long.`);
  const t = v.trim();
  return t === '' ? null : t;
}

function date(name: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) {
    throw new HttpError(400, `${name} must be a date like 2024-05-17, 2024-05 or 2024.`);
  }
  return v;
}

/** Validates an incoming patch; unknown fields are refused rather than ignored. */
export function validatePatch(body: unknown): UserPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Expected a JSON object.');
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    'progress',
    'dnfReason',
    'startedOn',
    'startedPrecision',
    'finishedOn',
    'finishedPrecision',
    'rating',
    'note',
    'takeaway',
    'hidden',
    'titleOverride',
    'kindOverride',
    'referenceOverride',
    'icloudOverride',
    'triage',
    'effortOverride',
    'preferredFileId',
    'seriesOverride',
    'seriesPositionOverride',
  ]);
  for (const k of Object.keys(b))
    if (!allowed.has(k)) throw new HttpError(400, `Unknown field "${k}".`);
  const p: UserPatch = {};
  if ('progress' in b) p.progress = oneOf('progress', b.progress, PROGRESS, false)!;
  if ('dnfReason' in b) p.dnfReason = oneOf('dnfReason', b.dnfReason, DNF_REASONS);
  if ('startedOn' in b) p.startedOn = date('startedOn', b.startedOn);
  if ('startedPrecision' in b)
    p.startedPrecision = oneOf('startedPrecision', b.startedPrecision, PRECISIONS);
  if ('finishedOn' in b) p.finishedOn = date('finishedOn', b.finishedOn);
  if ('finishedPrecision' in b)
    p.finishedPrecision = oneOf('finishedPrecision', b.finishedPrecision, PRECISIONS);
  if ('rating' in b) {
    if (
      b.rating !== null &&
      !(Number.isInteger(b.rating) && (b.rating as number) >= 1 && (b.rating as number) <= 10)
    ) {
      throw new HttpError(400, 'rating must be a whole number from 1 to 10, or null.');
    }
    p.rating = b.rating as number | null;
  }
  if ('note' in b) p.note = text('note', b.note);
  if ('takeaway' in b) p.takeaway = text('takeaway', b.takeaway);
  if ('hidden' in b) {
    if (typeof b.hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false.');
    p.hidden = b.hidden;
  }
  if ('titleOverride' in b) p.titleOverride = text('titleOverride', b.titleOverride);
  if ('kindOverride' in b) p.kindOverride = oneOf('kindOverride', b.kindOverride, KINDS);
  if ('referenceOverride' in b) {
    if (b.referenceOverride !== null && typeof b.referenceOverride !== 'boolean') {
      throw new HttpError(400, 'referenceOverride must be true, false or null.');
    }
    p.referenceOverride = b.referenceOverride as boolean | null;
  }
  if ('icloudOverride' in b)
    p.icloudOverride = oneOf('icloudOverride', b.icloudOverride, ['in', 'not_in'] as const);
  if ('preferredFileId' in b) {
    if (b.preferredFileId !== null && typeof b.preferredFileId !== 'string')
      throw new HttpError(400, 'preferredFileId must be a file id or null.');
    p.preferredFileId = b.preferredFileId as string | null;
  }
  if ('seriesOverride' in b) {
    if (b.seriesOverride !== null && typeof b.seriesOverride !== 'string')
      throw new HttpError(400, 'seriesOverride must be a series name, "" or null.');
    if (typeof b.seriesOverride === 'string' && b.seriesOverride.length > 500)
      throw new HttpError(400, 'seriesOverride is too long.');
    p.seriesOverride = typeof b.seriesOverride === 'string' ? b.seriesOverride.trim() : null;
  }
  if ('seriesPositionOverride' in b) {
    const v = b.seriesPositionOverride;
    if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000))
      throw new HttpError(
        400,
        'seriesPositionOverride must be a number from 0 to 100000, or null.',
      );
    p.seriesPositionOverride = v === null ? null : Math.round((v as number) * 100) / 100;
  }
  if ('triage' in b) p.triage = oneOf('triage', b.triage, ['want', 'maybe', 'never'] as const);
  if ('effortOverride' in b)
    p.effortOverride = oneOf('effortOverride', b.effortOverride, [
      'light',
      'medium',
      'heavy',
    ] as const);
  return p;
}

interface Row {
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
  title_override: string | null;
  kind_override: string | null;
  reference_override: number | null;
  icloud_override: string | null;
  triage: string | null;
  triage_at: string | null;
  effort_override: string | null;
  preferred_file_id: string | null;
  series_override: string | null;
  series_position_override: number | null;
}

export function ensureUserRow(db: DB, itemId: string): void {
  db.prepare('INSERT OR IGNORE INTO user_item (item_id, updated_at) VALUES (?, ?)').run(
    itemId,
    nowIso(),
  );
}

/** Applies a validated patch. `today` is injectable for tests. */
export function applyUserPatch(db: DB, itemId: string, p: UserPatch, today = todayLocal()): void {
  ensureUserRow(db, itemId);
  const row = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(itemId) as Row;
  const next: Row = { ...row };
  const now = nowIso();

  if (p.progress !== undefined && p.progress !== row.progress) {
    next.progress = p.progress;
    next.progress_at = now;
    // Starting now: record today, exactly — unless a start date is already known.
    if (
      row.progress === 'not_started' &&
      !['not_started', 'finished', 'dnf'].includes(p.progress) &&
      !row.started_on
    ) {
      next.started_on = today;
      next.started_precision = 'exact';
    }
    if (
      p.progress === 'finished' &&
      p.finishedOn === undefined &&
      p.finishedPrecision === undefined
    ) {
      next.finished_on = today;
      next.finished_precision = 'exact';
    }
    if (p.progress !== 'finished' && row.progress === 'finished') {
      next.finished_on = null;
      next.finished_precision = null;
    }
    if (p.progress !== 'dnf') next.dnf_reason = null;
    if (p.progress === 'not_started') {
      next.started_on = null;
      next.started_precision = null;
    }
  }
  if (p.dnfReason !== undefined) {
    if (p.dnfReason !== null && next.progress !== 'dnf')
      throw new HttpError(400, 'A DNF reason needs progress "dnf".');
    next.dnf_reason = p.dnfReason;
  }
  if (p.startedOn !== undefined) next.started_on = p.startedOn;
  if (p.startedPrecision !== undefined) next.started_precision = p.startedPrecision;
  if (p.finishedOn !== undefined) next.finished_on = p.finishedOn;
  if (p.finishedPrecision !== undefined) next.finished_precision = p.finishedPrecision;
  // An unknown date has no value; a date without a precision is exact.
  if (next.finished_precision === 'unknown') next.finished_on = null;
  if (next.started_precision === 'unknown') next.started_on = null;
  if (next.finished_on && !next.finished_precision) next.finished_precision = 'exact';
  if (next.started_on && !next.started_precision) next.started_precision = 'exact';
  if (p.rating !== undefined) next.rating = p.rating;
  if (p.note !== undefined) next.note = p.note;
  if (p.takeaway !== undefined) next.takeaway = p.takeaway;
  if (p.hidden !== undefined) next.hidden = p.hidden ? 1 : 0;
  if (p.titleOverride !== undefined) next.title_override = p.titleOverride;
  if (p.kindOverride !== undefined) next.kind_override = p.kindOverride;
  if (p.referenceOverride !== undefined)
    next.reference_override = p.referenceOverride === null ? null : p.referenceOverride ? 1 : 0;
  if (p.icloudOverride !== undefined) next.icloud_override = p.icloudOverride;
  if (p.triage !== undefined && p.triage !== row.triage) {
    next.triage = p.triage;
    next.triage_at = p.triage === null ? null : now;
  }
  if (p.effortOverride !== undefined) next.effort_override = p.effortOverride;
  if (p.preferredFileId !== undefined) next.preferred_file_id = p.preferredFileId;
  if (p.seriesOverride !== undefined) next.series_override = p.seriesOverride;
  if (p.seriesPositionOverride !== undefined)
    next.series_position_override = p.seriesPositionOverride;

  db.prepare(
    `UPDATE user_item SET progress = @progress, dnf_reason = @dnf_reason, started_on = @started_on,
       started_precision = @started_precision, finished_on = @finished_on,
       finished_precision = @finished_precision, progress_at = @progress_at, rating = @rating,
       note = @note, takeaway = @takeaway, hidden = @hidden, title_override = @title_override,
       kind_override = @kind_override, reference_override = @reference_override,
       icloud_override = @icloud_override, triage = @triage, triage_at = @triage_at,
       effort_override = @effort_override, preferred_file_id = @preferred_file_id,
       series_override = @series_override, series_position_override = @series_position_override,
       updated_at = @updated_at
     WHERE item_id = @item_id`,
  ).run({ ...next, updated_at: now, item_id: itemId });
}

/** Shortlist: an ordered "next up" queue (§13.9). Positions are 1..n with no gaps. */
export function shortlistAdd(db: DB, itemId: string): void {
  ensureUserRow(db, itemId);
  const has = db
    .prepare('SELECT shortlist_position FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId);
  if (has !== null) return;
  const max =
    (db.prepare('SELECT MAX(shortlist_position) FROM user_item').pluck().get() as number | null) ??
    0;
  db.prepare('UPDATE user_item SET shortlist_position = ?, updated_at = ? WHERE item_id = ?').run(
    max + 1,
    nowIso(),
    itemId,
  );
}

export function shortlistRemove(db: DB, itemId: string): void {
  db.transaction(() => {
    db.prepare(
      'UPDATE user_item SET shortlist_position = NULL, updated_at = ? WHERE item_id = ?',
    ).run(nowIso(), itemId);
    compactShortlist(db);
  })();
}

export function shortlistMove(db: DB, itemId: string, direction: 'up' | 'down'): void {
  db.transaction(() => {
    const pos = db
      .prepare('SELECT shortlist_position FROM user_item WHERE item_id = ?')
      .pluck()
      .get(itemId) as number | null | undefined;
    if (pos === null || pos === undefined)
      throw new HttpError(404, 'That item is not on the shortlist.');
    const target = direction === 'up' ? pos - 1 : pos + 1;
    const other = db
      .prepare('SELECT item_id FROM user_item WHERE shortlist_position = ?')
      .pluck()
      .get(target) as string | undefined;
    if (!other) return;
    const now = nowIso();
    db.prepare('UPDATE user_item SET shortlist_position = NULL WHERE item_id = ?').run(itemId);
    db.prepare('UPDATE user_item SET shortlist_position = ?, updated_at = ? WHERE item_id = ?').run(
      pos,
      now,
      other,
    );
    db.prepare('UPDATE user_item SET shortlist_position = ?, updated_at = ? WHERE item_id = ?').run(
      target,
      now,
      itemId,
    );
  })();
}

function compactShortlist(db: DB): void {
  const ids = db
    .prepare(
      'SELECT item_id FROM user_item WHERE shortlist_position IS NOT NULL ORDER BY shortlist_position',
    )
    .pluck()
    .all() as string[];
  db.prepare(
    'UPDATE user_item SET shortlist_position = NULL WHERE shortlist_position IS NOT NULL',
  ).run();
  const set = db.prepare('UPDATE user_item SET shortlist_position = ? WHERE item_id = ?');
  ids.forEach((id, i) => set.run(i + 1, id));
}
