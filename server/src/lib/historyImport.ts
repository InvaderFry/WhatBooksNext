import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { samePerson } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import { applyUserPatch, type UserPatch } from './progress.ts';
import {
  isbnIndex,
  itemsWithTitle,
  normIsbn,
  parseCsv,
  progressFrom,
  rowKey,
  titleIndex,
} from './store.ts';

export type HistorySource = 'goodreads' | 'storygraph';
type ReadingDate = { value: string | null; precision: 'exact' | 'approximate' | 'unknown' };
interface HistoryRow {
  line: number;
  title: string;
  author: string | null;
  authors: string[];
  isbn: string | null;
  key: string;
  progress: string | null;
  rating: number | null;
  note: string | null;
  finished: ReadingDate;
}
export interface HistoryPreviewRow {
  line: number;
  title: string;
  author: string | null;
  outcome: 'already' | 'isbn' | 'possible' | 'history' | 'skip';
  itemId: string | null;
  itemTitle: string | null;
  applies: string[];
  kept: string[];
}

/** Only explicit calendar dates: JS's permissive Date parser invents days and rolls invalid dates. */
export function historyDate(raw: string, source: HistorySource): ReadingDate {
  const unknown: ReadingDate = { value: null, precision: 'unknown' };
  const t = raw.trim();
  if (!t) return unknown;
  let m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(t);
  let year: number, month: number | null, day: number | null;
  if (m) {
    year = Number(m[1]);
    month = m[2] ? Number(m[2]) : null;
    day = m[3] ? Number(m[3]) : null;
  } else if (source === 'storygraph' && (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) {
    [year, month, day] = [Number(m[3]), Number(m[2]), Number(m[1])];
  } else return unknown;
  if (year < 1 || year > 9999 || (month !== null && (month < 1 || month > 12))) return unknown;
  const y = String(year).padStart(4, '0');
  if (month === null) return { value: y, precision: 'approximate' };
  const ym = `${y}-${String(month).padStart(2, '0')}`;
  if (day === null) return { value: ym, precision: 'approximate' };
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > days) return unknown;
  return { value: `${ym}-${String(day).padStart(2, '0')}`, precision: 'exact' };
}

function readRows(text: string, source: HistorySource) {
  const all = parseCsv(text);
  const headers = all[0]?.map((s) => s.trim().toLowerCase()) ?? [];
  const required =
    source === 'goodreads'
      ? ['title', 'author', 'exclusive shelf']
      : ['title', 'authors', 'read status'];
  if (required.some((h) => !headers.includes(h)))
    throw new HttpError(
      400,
      `This doesn't look like a ${source === 'goodreads' ? 'Goodreads' : 'StoryGraph'} export. Required columns: ${required.join(', ')}.`,
    );
  if (new Set(headers).size !== headers.length)
    throw new HttpError(400, 'The file has duplicate column names.');
  if (all.length > 20_001) throw new HttpError(400, 'That’s more than 20,000 rows.');
  const problems: string[] = [];
  const rows: HistoryRow[] = [];
  const seen = new Set<string>();
  all.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.length !== headers.length) {
      problems.push(`Row ${line}: the number of fields differs from the header, skipped.`);
      return;
    }
    const get = (h: string) => (cells[headers.indexOf(h)] ?? '').trim();
    const title = get('title');
    if (!title || title.length > 500) {
      problems.push(`Row ${line}: missing or overly long title, skipped.`);
      return;
    }
    const author = get(source === 'goodreads' ? 'author' : 'authors') || null;
    // Both exporters separate additional authors with commas; each is a creator, not one name.
    const authors =
      source === 'storygraph'
        ? (author ?? '').split(/,\s*/).filter(Boolean)
        : [author, ...get('additional authors').split(/,\s*/)].filter((a): a is string =>
            Boolean(a),
          );
    // Goodreads wraps ISBNs in ="..." to keep Excel from stripping leading zeroes.
    // StoryGraph's UID may be a UUID instead; never strip its letters to invent an ISBN.
    const isbnText = (
      source === 'goodreads' ? get('isbn13') || get('isbn') : get('isbn/uid')
    ).replace(/^="(.*)"$/, '$1');
    const isbn = /^[\dXx\s-]+$/.test(isbnText) ? normIsbn(isbnText) : null;
    const key = rowKey({ title, author, isbn, store: 'other' });
    if (seen.has(key)) {
      problems.push(`Row ${line}: same book as an earlier row, skipped.`);
      return;
    }
    seen.add(key);
    const status = get(source === 'goodreads' ? 'exclusive shelf' : 'read status');
    const progress = progressFrom(status);
    if (status && !progress)
      problems.push(`Row ${line}: status “${status}” not understood, left out.`);
    const rawRating = get(source === 'goodreads' ? 'my rating' : 'star rating');
    const n = /^\d+(?:\.\d+)?$/.test(rawRating) ? Number(rawRating) : NaN;
    const validRating =
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 5 &&
      (source === 'goodreads' ? Number.isInteger(n) : Number.isInteger(n * 4));
    const rating = validRating && n > 0 ? Math.max(1, Math.round(n * 2)) : null;
    if (rawRating && !validRating)
      problems.push(`Row ${line}: rating “${rawRating}” isn't a valid rating out of 5, left out.`);
    if (rating !== null && rating !== n * 2)
      problems.push(
        `Row ${line}: ${n}/5 becomes ${n * 2}/10, rounded to ${rating}/10 (whole-number ratings).`,
      );
    const dateText = get(source === 'goodreads' ? 'date read' : 'last date read');
    const finished = historyDate(dateText, source);
    if (dateText && finished.precision === 'unknown')
      problems.push(`Row ${line}: date “${dateText}” not understood, kept unknown.`);
    if (Number(get('read count')) > 1)
      problems.push(
        `Row ${line}: rereads are represented by one reading and the last finish date.`,
      );
    rows.push({
      line,
      title,
      author,
      authors,
      isbn,
      key,
      progress,
      rating,
      finished,
      note:
        [
          get(source === 'goodreads' ? 'my review' : 'review'),
          ...(source === 'goodreads' ? [get('private notes')] : []),
        ]
          .filter(Boolean)
          .join('\n\n') || null,
    });
  });
  return { rows, problems };
}

function ownerChanges(db: DB, id: string | null, r: HistoryRow) {
  const u = id
    ? (db
        .prepare(
          'SELECT progress, progress_at, started_on, started_precision, finished_on, finished_precision, rating, note FROM user_item WHERE item_id = ?',
        )
        .get(id) as
        | {
            progress: string;
            progress_at: string | null;
            started_on: string | null;
            started_precision: string | null;
            finished_on: string | null;
            finished_precision: string | null;
            rating: number | null;
            note: string | null;
          }
        | undefined)
    : undefined;
  const patch: UserPatch = {};
  const applies: string[] = [],
    kept: string[] = [];
  const canSetProgress = !u || (u.progress === 'not_started' && !u.progress_at);
  if (r.progress && r.progress !== 'not_started') {
    if (canSetProgress) {
      patch.progress = r.progress;
      // Imported actions happened in the past, never on the day the CSV was uploaded.
      patch.startedOn = u?.started_on ?? null;
      patch.startedPrecision = u?.started_precision ?? 'unknown';
      if (r.progress === 'finished') {
        patch.finishedOn = r.finished.value;
        patch.finishedPrecision = r.finished.precision;
      }
      applies.push(`progress ${r.progress.replaceAll('_', ' ')}`);
    } else if (u.progress !== r.progress)
      kept.push(`progress: yours is ${u.progress.replaceAll('_', ' ')}`);
    if (r.progress === 'finished' && canSetProgress)
      applies.push(
        r.finished.value
          ? `finished ${r.finished.value} (${r.finished.precision})`
          : 'finished date unknown',
      );
    else if (
      r.progress === 'finished' &&
      u?.progress === 'finished' &&
      r.finished.value !== u.finished_on
    )
      kept.push('finished date: yours is kept');
  }
  if (r.rating !== null) {
    if (!u || u.rating === null) {
      patch.rating = r.rating;
      applies.push(`rating ${r.rating}/10`);
    } else if (u.rating !== r.rating)
      kept.push(`rating: file ${r.rating}/10, yours ${u.rating}/10`);
  }
  if (r.note) {
    if (!u?.note) {
      patch.note = r.note;
      applies.push('note');
    } else if (u.note !== r.note) kept.push('note: yours is kept');
  }
  return { patch, applies, kept };
}

function plan(db: DB, text: string, source: HistorySource) {
  const { rows, problems } = readRows(text, source);
  const isbns = isbnIndex(db),
    titles = titleIndex(db);
  const facts = new Map(
    (
      db
        .prepare(
          `SELECT i.id, COALESCE(u.title_override, i.title) AS title, i.creators
        FROM items i LEFT JOIN user_item u ON u.item_id = i.id`,
        )
        .all() as {
        id: string;
        title: string;
        creators: string;
      }[]
    ).map((r) => [r.id, r]),
  );
  const planned = rows.map((r) => {
    const prior = db
      .prepare('SELECT item_id FROM import_keys WHERE source = ? AND row_key = ?')
      .pluck()
      .get(source, r.key) as string | undefined;
    let outcome: HistoryPreviewRow['outcome'] = prior ? 'already' : 'history';
    let itemId: string | null = prior ?? null;
    if (!prior) {
      const hits = [...(isbns.get(r.isbn ?? '') ?? [])];
      const f = hits.length === 1 ? facts.get(hits[0]!) : undefined;
      // History belongs to a work only when the ISBN also agrees with its title or author.
      if (
        f &&
        (titleCompareKey(f.title) === titleCompareKey(r.title) ||
          parseJson<{ name: string }[]>(f.creators, []).some((c) =>
            r.authors.some((a) => samePerson(c.name, a)),
          ))
      )
        [outcome, itemId] = ['isbn', f.id];
      else {
        const same = [
          ...new Set(
            (r.authors.length ? r.authors : [null]).flatMap((a) =>
              itemsWithTitle(titles, r.title, a),
            ),
          ),
        ];
        if (same.length === 1) [outcome, itemId] = ['possible', same[0]!];
        else if (!r.progress || r.progress === 'not_started') outcome = 'skip';
      }
    }
    const changes = ownerChanges(db, itemId, r);
    return {
      row: r,
      preview: {
        line: r.line,
        title: r.title,
        author: r.author,
        outcome,
        itemId,
        itemTitle: itemId ? (facts.get(itemId)?.title ?? null) : null,
        applies: outcome === 'already' || outcome === 'skip' ? [] : changes.applies,
        kept: changes.kept,
      } satisfies HistoryPreviewRow,
    };
  });
  return { planned, problems };
}

export function previewHistory(db: DB, text: string, source: HistorySource) {
  const { planned, problems } = plan(db, text, source);
  return { source, rows: planned.map((p) => p.preview), problems };
}

export function importHistory(
  db: DB,
  text: string,
  source: HistorySource,
  opts: { attach: number[]; keepUnmatched: boolean },
) {
  return db.transaction(() => {
    const { planned } = plan(db, text, source);
    const counts = { added: 0, attached: 0, already: 0, skipped: 0 };
    const now = nowIso();
    for (const { row: r, preview: p } of planned) {
      if (p.outcome === 'already') {
        counts.already++;
        continue;
      }
      let itemId = p.itemId;
      if (p.outcome === 'isbn' || (p.outcome === 'possible' && opts.attach.includes(r.line)))
        counts.attached++;
      else if (
        p.outcome === 'history' &&
        opts.keepUnmatched &&
        r.progress &&
        r.progress !== 'not_started'
      ) {
        itemId = newId();
        db.prepare(
          `INSERT INTO items (id, title, title_source, creators, identifiers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          itemId,
          r.title,
          source,
          JSON.stringify(r.authors.map((name) => ({ name }))),
          JSON.stringify(r.isbn ? { isbn: [r.isbn] } : {}),
          now,
          now,
        );
        db.prepare(
          `INSERT INTO locations (id, item_id, kind, note, created_at, updated_at) VALUES (?, ?, 'history', ?, ?, ?)`,
        ).run(
          newId(),
          itemId,
          `Imported from ${source === 'goodreads' ? 'Goodreads' : 'StoryGraph'}`,
          now,
          now,
        );
        counts.added++;
      } else {
        counts.skipped++;
        continue;
      }
      const { patch } = ownerChanges(db, itemId, r);
      if (Object.keys(patch).length) applyUserPatch(db, itemId!, patch);
      db.prepare(
        'INSERT INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(source, r.key, itemId, now);
    }
    syncSeries(db);
    return counts;
  })();
}
