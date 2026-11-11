import { STORE_FILE_MAX_RECORDS, STORE_SHRINK_WARNING } from '../config.ts';
import type { DB } from '../db/database.ts';
import { titleCompareKey } from '../identify/filename.ts';
import { samePerson } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, newId, nowIso, parseJson } from '../util.ts';
import { applyUserPatch, KINDS } from './progress.ts';
import {
  addLocation,
  createStoreItem,
  isbnIndex,
  itemsWithTitle,
  linkWouldFill,
  normIsbn,
  ownerChanges,
  setLocationLink,
  storeLinkOrProblem,
  titleIndex,
  titleOfItem,
  type ImportFill,
  type Store,
  type StoreLink,
} from './store.ts';

/**
 * The store purchases file a collector downloads (store purchases plan, "1b"): checked field by
 * field, previewed, then imported on the owner's say-so. Same rules as the store CSV: an import
 * fills only what's empty, owner corrections win, and importing again adds nothing twice. The
 * app reads the file during preview and import and keeps no copy; it keeps the books,
 * store_purchases and a title-free run log.
 */

export const FILE_FORMAT = 'whatBooksNext-store-purchases';
export const FILE_FORMAT_VERSION = 1;
export const SERVICES = ['kindle', 'google_play', 'kobo', 'globalcomix'] as const;
export type Service = (typeof SERVICES)[number];
export const SERVICE_LABELS: Record<Service, string> = {
  kindle: 'Kindle',
  google_play: 'Google Play Books',
  kobo: 'Kobo',
  globalcomix: 'GlobalComix',
};

/**
 * Each store's collector (store purchases plan, "A collector that hasn't been checked is never
 * shown as working"). `checkedOn` is set only after the owner's real-account check.
 */
export const COLLECTORS: Record<
  Service,
  { state: 'checked' | 'not_checked' | 'not_built'; checkedOn: string | null; page: string | null }
> = {
  // Checked on the owner's account 2026-11-11 (A2: complete over several pages, layout passed).
  kindle: {
    state: 'checked',
    checkedOn: '2026-11-11',
    page: 'https://read.amazon.com/kindle-library',
  },
  // Checked on the owner's account 2026-11-11 (version 2: complete, 23 found, layout passed).
  google_play: {
    state: 'checked',
    checkedOn: '2026-11-11',
    page: 'https://play.google.com/books?source=purchases',
  },
  // Checked on the owner's account 2026-11-11 (A2/A3: "seems to work"; report not shared).
  kobo: {
    state: 'checked',
    checkedOn: '2026-11-11',
    page: 'https://www.kobo.com/us/en/library/books',
  },
  // Built 2026-11-11 from the owner's fourth look-around report; not yet run on their account (A2).
  globalcomix: {
    state: 'not_checked',
    checkedOn: null,
    page: 'https://globalcomix.com/my-shelf/purchases',
  },
};

const ACQUISITIONS = ['purchase', 'free_claim', 'uncertain'] as const;
type Acquisition = (typeof ACQUISITIONS)[number];
const COMPLETION = ['complete', 'partial', 'failed'] as const;
const REASONS = [
  'finished',
  'cancelled',
  'signed_out',
  'blocked',
  'layout_changed',
  'limit_reached',
  'error',
] as const;
const UNITS = ['issue', 'volume', 'collection', 'book'] as const;
const ROLES = ['author', 'writer', 'artist', 'unknown'] as const;
const STATUSES = ['not_started', 'in_progress', 'finished'] as const;

export interface PurchaseRecord {
  storeRecordId: string;
  idKind: string;
  title: string;
  creators: { name: string; role: (typeof ROLES)[number] }[];
  kind: string | null;
  unit: (typeof UNITS)[number] | null;
  series: string | null;
  seriesIndex: string | null;
  isbn: string | null;
  acquisition: Acquisition;
  evidence: string;
  acquiredAt: { value: string; precision: 'day' | 'month' | 'year' } | null;
  readingStatus: (typeof STATUSES)[number] | null;
  link: StoreLink | null;
}

export interface PurchaseFile {
  service: Service;
  adapterVersion: string;
  source: string;
  collectedAt: string;
  region: string | null;
  accountScope: string | null;
  completion: {
    status: (typeof COMPLETION)[number];
    reason: (typeof REASONS)[number];
    text: string;
  };
  counts: { seen: number; included: number; uncertain: number; excluded: Record<string, number> };
  records: PurchaseRecord[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** Reads and checks a file. Envelope problems refuse the whole file; a bad record is a problem line. */
export function readPurchaseFile(text: string): { file: PurchaseFile; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new HttpError(400, 'That isn’t a whatBooksNext store file (it isn’t JSON).');
  }
  const b = (raw ?? {}) as Record<string, unknown>;
  if (b.format !== FILE_FORMAT)
    throw new HttpError(
      400,
      'That isn’t a whatBooksNext store file. Choose the file the collector downloaded.',
    );
  if (!Number.isInteger(b.formatVersion) || (b.formatVersion as number) < 1)
    throw new HttpError(400, 'The file’s format version is missing or wrong.');
  if ((b.formatVersion as number) > FILE_FORMAT_VERSION)
    throw new HttpError(
      400,
      'This file was made by a newer collector than this whatBooksNext understands. Update whatBooksNext, then try again.',
    );
  const service = oneOf(SERVICES, b.service);
  if (!service) throw new HttpError(400, `The file’s store must be one of ${SERVICES.join(', ')}.`);
  const adapterVersion = str(b.adapterVersion, 40);
  if (!adapterVersion) throw new HttpError(400, 'The file doesn’t say which collector made it.');
  const src = (b.source ?? {}) as Record<string, unknown>;
  const sourceType = oneOf(['collector', 'official_export'] as const, src.type);
  if (!sourceType) throw new HttpError(400, 'The file doesn’t say where it came from.');
  const collectedAt = str(b.collectedAt, 40);
  if (!collectedAt || Number.isNaN(Date.parse(collectedAt)))
    throw new HttpError(400, 'The file doesn’t say when it was made.');
  const c = (b.completion ?? {}) as Record<string, unknown>;
  const status = oneOf(COMPLETION, c.status);
  const reason = oneOf(REASONS, c.reason);
  if (!status || !reason)
    throw new HttpError(400, 'The file doesn’t say whether the scan finished.');
  const n = (b.counts ?? {}) as Record<string, unknown>;
  const counts = {
    seen: count(n.seen),
    included: count(n.included),
    uncertain: count(n.uncertain),
  };
  if (counts.seen === null || counts.included === null || counts.uncertain === null)
    throw new HttpError(400, 'The file’s counts are missing.');
  const excluded: Record<string, number> = {};
  for (const [k, v] of Object.entries((n.excluded ?? {}) as Record<string, unknown>))
    if (/^[a-z_]{1,30}$/.test(k) && count(v) !== null) excluded[k] = v as number;
  if (!Array.isArray(b.records)) throw new HttpError(400, 'The file has no list of books.');
  if (b.records.length > STORE_FILE_MAX_RECORDS)
    throw new HttpError(400, `That’s more than ${STORE_FILE_MAX_RECORDS.toLocaleString()} books.`);
  const scope = str(b.accountScope, 128);
  if (scope && !/^[A-Za-z0-9_.:-]+$/.test(scope))
    throw new HttpError(400, 'The file’s account scope isn’t in the expected form.');

  const problems: string[] = [];
  const records: PurchaseRecord[] = [];
  const keys = new Set<string>();
  b.records.forEach((r, i) => {
    const where = `Book ${i + 1}`;
    try {
      const rec = readRecord(service, r, problems, where);
      const key = recordKey(rec);
      if (keys.has(key)) problems.push(`${where}: the same book as an earlier one, skipped.`);
      else {
        keys.add(key);
        records.push(rec);
      }
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message} Skipped.`);
    }
  });
  const uncertain = records.filter((r) => r.acquisition === 'uncertain').length;
  if (records.length - uncertain !== counts.included || uncertain !== counts.uncertain)
    problems.unshift(
      `The file says ${counts.included} books and ${counts.uncertain} uncertain, but holds ${records.length - uncertain} and ${uncertain} that can be read. Check it was made by the collector and not edited.`,
    );
  return {
    file: {
      service,
      adapterVersion,
      source: sourceType + (str(src.file, 100) ? ` (${str(src.file, 100)})` : ''),
      collectedAt,
      region: str(b.region, 100),
      accountScope: scope,
      completion: { status, reason, text: str(c.text, 300) ?? '' },
      counts: {
        seen: counts.seen,
        included: counts.included,
        uncertain: counts.uncertain,
        excluded,
      },
      records,
    },
    problems,
  };
}

function readRecord(
  service: Service,
  raw: unknown,
  problems: string[],
  where: string,
): PurchaseRecord {
  if (!raw || typeof raw !== 'object') throw new Error('not a book record.');
  const r = raw as Record<string, unknown>;
  const storeRecordId = str(r.storeRecordId, 200);
  if (!storeRecordId) throw new Error('no store ID.');
  const idKind = typeof r.idKind === 'string' && /^[a-z_]{1,30}$/.test(r.idKind) ? r.idKind : null;
  if (!idKind) throw new Error('no ID kind.');
  const title = str(r.title, 500);
  if (!title) throw new Error('no title.');
  const acq = (r.acquisition ?? {}) as Record<string, unknown>;
  const acquisition = oneOf(ACQUISITIONS, acq.type);
  if (!acquisition) throw new Error('it doesn’t say how the book was acquired.');
  const unit = oneOf(UNITS, r.unit);
  if (service === 'globalcomix' && !unit)
    throw new Error('a GlobalComix record must say whether it’s an issue, volume or collection.');
  const creators = Array.isArray(r.creators)
    ? r.creators
        .map((x) => (x ?? {}) as Record<string, unknown>)
        .map((x) => ({ name: str(x.name, 300), role: oneOf(ROLES, x.role) ?? 'unknown' }))
        .filter((x): x is PurchaseRecord['creators'][number] => !!x.name)
    : [];
  const kindRaw = oneOf(['book', 'comic', 'manga', 'unknown'] as const, r.kind);
  let seriesIndex = str(r.seriesIndex, 20);
  if (seriesIndex && !/^\d+(\.\d+)?$/.test(seriesIndex)) {
    problems.push(`${where}: the series number “${seriesIndex}” isn’t a number, left out.`);
    seriesIndex = null;
  }
  const at = (r.acquiredAt ?? null) as Record<string, unknown> | null;
  const precision = at ? oneOf(['day', 'month', 'year'] as const, at.precision) : null;
  const value = at ? str(at.value, 40) : null;
  const acquiredAt =
    value && precision && /^\d{4}(-\d{2}(-\d{2})?)?/.test(value) ? { value, precision } : null;
  let link: StoreLink | null = null;
  for (const k of ['readUrl', 'pageUrl'] as const) {
    if (link || typeof r[k] !== 'string') continue;
    const got = storeLinkOrProblem(service, r[k] as string);
    if (got.problem) problems.push(`${where}: link left out. ${got.problem}`);
    // The reader link first; a page link only when there's no reader link.
    link = got.link ? { ...got.link, kind: k === 'readUrl' ? got.link.kind : 'page' } : null;
  }
  return {
    storeRecordId,
    idKind,
    title,
    creators,
    // Only the store's own word, and only kinds this app knows; "book" says nothing more.
    kind: kindRaw && (KINDS as readonly string[]).includes(kindRaw) ? kindRaw : null,
    unit,
    series: str(r.series, 300),
    seriesIndex,
    isbn: normIsbn(str(r.isbn, 40)),
    acquisition,
    evidence: str(acq.evidence, 200) ?? '',
    acquiredAt,
    readingStatus: oneOf(STATUSES, r.readingStatus),
    link,
  };
}

const recordKey = (r: Pick<PurchaseRecord, 'idKind' | 'storeRecordId'>) =>
  `${r.idKind}:${r.storeRecordId}`;

/** The account the file is for: its own scope, else "default", else a name the owner gave. */
export function scopeFor(file: PurchaseFile, accountName?: string | null): string {
  if (file.accountScope) return file.accountScope;
  const name = (accountName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return name ? `named:${name}` : 'default';
}

/** Store reading status → the app's progress; "not started" records nothing. */
const PROGRESS: Record<string, string | null> = {
  not_started: null,
  in_progress: 'into_it',
  finished: 'finished',
};

const fillOf = (service: Service, r: PurchaseRecord): ImportFill => ({
  fields: { store: service as Store, link: r.link },
  progress: r.readingStatus ? PROGRESS[r.readingStatus]! : null,
  rating: null,
  note: null,
});

export interface PurchasePreviewRow {
  key: string;
  title: string;
  author: string | null;
  acquisition: Acquisition;
  evidence: string;
  /** As for the CSV: already imported, same ISBN, same title and author (tick), or new. */
  outcome: 'already' | 'isbn' | 'possible' | 'new';
  itemId: string | null;
  itemTitle: string | null;
  /**
   * A possible match with another book in this same file (an earlier row with the same title and
   * author, often a second edition at the store): its key. Ticked, both become one book.
   */
  sameInFile: string | null;
  applies: string[];
  kept: string[];
}

export interface PurchasePreview {
  service: Service;
  label: string;
  adapterVersion: string;
  source: string;
  collectedAt: string;
  region: string | null;
  scope: string;
  /** Whether the file names its account; if not, the owner is asked "your only account?". */
  scopeFromFile: boolean;
  completion: PurchaseFile['completion'];
  counts: PurchaseFile['counts'];
  rows: PurchasePreviewRow[];
  problems: string[];
  /** Far fewer books than the last complete scan of this account: maybe the store changed. */
  shrink: { before: number; now: number } | null;
  /** Books from earlier scans this complete scan didn't find: they'd go to Needs review. */
  notSeen: number;
}

export function previewPurchases(
  db: DB,
  text: string,
  opts: { accountName?: string | null } = {},
): PurchasePreview {
  const { file, problems } = readPurchaseFile(text);
  const scope = scopeFor(file, opts.accountName);
  const isbns = isbnIndex(db);
  const titles = titleIndex(db);
  const priorKey = db
    .prepare('SELECT item_id FROM import_keys WHERE source = ? AND row_key = ?')
    .pluck();
  // Earlier new books in this file, by title, to spot the same book twice (two editions).
  const newInFile = new Map<string, { key: string; title: string; author: string | null }[]>();
  const rows: PurchasePreviewRow[] = file.records.map((r) => {
    let outcome: PurchasePreviewRow['outcome'] = 'new';
    let itemId: string | null = null;
    let sameInFile: { key: string; title: string } | null = null;
    const prior = priorKey.get(`store_json:${file.service}`, `${scope}:${recordKey(r)}`) as
      string | undefined;
    const author = r.creators[0]?.name ?? null;
    if (prior) [outcome, itemId] = ['already', prior];
    else if (r.isbn && isbns.get(r.isbn)?.size === 1)
      [outcome, itemId] = ['isbn', [...isbns.get(r.isbn)!][0]!];
    else {
      const same = itemsWithTitle(titles, r.title, author);
      if (same.length === 1) [outcome, itemId] = ['possible', same[0]!];
    }
    if (outcome === 'new') {
      const t = titleCompareKey(r.title);
      const earlier = (newInFile.get(t) ?? []).find(
        (x) => !author || !x.author || samePerson(x.author, author),
      );
      if (t && earlier) {
        outcome = 'possible';
        sameInFile = earlier;
      } else if (t)
        newInFile.set(t, [
          ...(newInFile.get(t) ?? []),
          { key: recordKey(r), title: r.title, author },
        ]);
    }
    const { applies, kept } = ownerChanges(db, itemId, fillOf(file.service, r));
    return {
      key: recordKey(r),
      title: r.title,
      author: r.creators.map((c) => c.name).join(', ') || null,
      acquisition: r.acquisition,
      evidence: r.evidence,
      outcome,
      itemId,
      itemTitle: itemId ? titleOfItem(db, itemId) : (sameInFile?.title ?? null),
      sameInFile: sameInFile?.key ?? null,
      // A book imported before only gains a missing link (as with the CSV).
      applies: outcome === 'already' ? applies.filter((a) => a === 'a link to read it') : applies,
      kept,
    };
  });
  const found = file.counts.included + file.counts.uncertain;
  const last = lastComplete(db, file.service, scope);
  const shrink =
    file.completion.status === 'complete' &&
    last !== null &&
    found < last * (1 - STORE_SHRINK_WARNING)
      ? { before: last, now: found }
      : null;
  return {
    service: file.service,
    label: SERVICE_LABELS[file.service],
    adapterVersion: file.adapterVersion,
    source: file.source,
    collectedAt: file.collectedAt,
    region: file.region,
    scope,
    scopeFromFile: !!file.accountScope,
    completion: file.completion,
    counts: file.counts,
    rows,
    problems,
    shrink,
    notSeen: file.completion.status === 'complete' ? notSeenKeys(db, file, scope).length : 0,
  };
}

/** Books found by the last complete scan of this account (from the run log), or null. */
function lastComplete(db: DB, service: Service, scope: string): number | null {
  const c = db
    .prepare(
      `SELECT counts FROM store_import_runs WHERE service = ? AND account_scope = ?
         AND completion = 'complete' ORDER BY imported_at DESC LIMIT 1`,
    )
    .pluck()
    .get(service, scope) as string | undefined;
  if (!c) return null;
  const n = parseJson<{ included?: number; uncertain?: number }>(c, {});
  return (n.included ?? 0) + (n.uncertain ?? 0);
}

/** Purchases of this account that this file doesn't list (only meaningful for a complete scan). */
function notSeenKeys(db: DB, file: PurchaseFile, scope: string): string[] {
  const inFile = new Set(file.records.map(recordKey));
  return (
    db
      .prepare(
        `SELECT id, id_kind, store_record_id FROM store_purchases
         WHERE service = ? AND account_scope = ?`,
      )
      .all(file.service, scope) as { id: string; id_kind: string; store_record_id: string }[]
  )
    .filter((p) => !inFile.has(`${p.id_kind}:${p.store_record_id}`))
    .map((p) => p.id);
}

export interface PurchaseImportResult {
  added: number;
  attached: number;
  already: number;
  skipped: number;
  links: number;
  notSeen: number;
}

/**
 * Imports the file as previewed. `attach`: possible matches the owner ticked; `uncertain`:
 * uncertain-ownership books the owner ticked; `keepNew`: books matching nothing become store
 * books (unverified until a lookup finds them) or are skipped. `confirmShrink`: the owner saw the
 * "far fewer books" warning and still wants books not seen to go to review.
 */
export function importPurchases(
  db: DB,
  text: string,
  opts: {
    attach: string[];
    uncertain: string[];
    keepNew: boolean;
    accountName?: string | null;
    confirmShrink?: boolean;
  },
): PurchaseImportResult {
  return db.transaction(() => {
    const { file } = readPurchaseFile(text);
    const preview = previewPurchases(db, text, { accountName: opts.accountName });
    const scope = preview.scope;
    const byKey = new Map(file.records.map((r) => [recordKey(r), r]));
    const now = nowIso();
    const complete = file.completion.status === 'complete';
    const counts: PurchaseImportResult = {
      added: 0,
      attached: 0,
      already: 0,
      skipped: 0,
      links: 0,
      notSeen: 0,
    };
    const source = `store_json:${file.service}`;
    const seen = db.prepare(
      `UPDATE store_purchases SET last_seen_at = ?, adapter_version = ?,
         last_complete_scan_at = CASE WHEN ? THEN ? ELSE last_complete_scan_at END,
         not_seen_since = NULL, not_seen_kept = 0
       WHERE service = ? AND account_scope = ? AND id_kind = ? AND store_record_id = ?`,
    );
    // The book each row became in this import, for later rows ticked as the same book.
    const made = new Map<string, string>();
    for (const p of preview.rows) {
      const r = byKey.get(p.key)!;
      if (p.outcome === 'already') {
        counts.already++;
        seen.run(
          now,
          file.adapterVersion,
          complete ? 1 : 0,
          now,
          file.service,
          scope,
          r.idKind,
          r.storeRecordId,
        );
        const loc = r.link
          ? (db
              .prepare(
                "SELECT id FROM locations WHERE item_id = ? AND kind = 'store' AND store = ?",
              )
              .pluck()
              .get(p.itemId, file.service) as string | undefined)
          : undefined;
        if (loc && setLocationLink(db, loc, r.link!, false)) counts.links++;
        continue;
      }
      if (r.acquisition === 'uncertain' && !opts.uncertain.includes(p.key)) {
        counts.skipped++;
        continue;
      }
      let itemId: string;
      const joinTo =
        p.sameInFile && opts.attach.includes(p.key) ? made.get(p.sameInFile) : undefined;
      if (joinTo) {
        // The same book twice in this file (two editions): one book, one store copy.
        itemId = joinTo;
        addLocation(db, itemId, file.service as Store, false, r.link);
        counts.attached++;
      } else if (
        p.outcome === 'isbn' ||
        (p.outcome === 'possible' && !p.sameInFile && opts.attach.includes(p.key))
      ) {
        itemId = p.itemId!;
        if (r.link && linkWouldFill(db, itemId, file.service as Store) === 'fill') counts.links++;
        addLocation(db, itemId, file.service as Store, false, r.link);
        counts.attached++;
      } else if (opts.keepNew) {
        itemId = createStoreItem(db, {
          title: r.title,
          author: r.creators[0]?.name ?? null,
          kind: r.kind,
          isbn: r.isbn,
          series: r.series,
          number: r.series ? r.seriesIndex : null,
          store: file.service as Store,
          link: r.link,
        });
        if (r.link) counts.links++;
        counts.added++;
      } else {
        counts.skipped++;
        continue;
      }
      made.set(p.key, itemId);
      const { patch } = ownerChanges(db, itemId, fillOf(file.service, r));
      if (Object.keys(patch).length) applyUserPatch(db, itemId, patch);
      db.prepare(
        'INSERT OR IGNORE INTO import_keys (source, row_key, item_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(source, `${scope}:${p.key}`, itemId, now);
      db.prepare(
        `INSERT INTO store_purchases (id, item_id, service, account_scope, store_record_id, id_kind,
           unit, acquisition, acquired_at, acquired_precision, first_seen_at, last_seen_at,
           last_complete_scan_at, adapter_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service, account_scope, id_kind, store_record_id) DO UPDATE SET
           item_id = excluded.item_id, last_seen_at = excluded.last_seen_at,
           adapter_version = excluded.adapter_version, not_seen_since = NULL, not_seen_kept = 0`,
      ).run(
        newId(),
        itemId,
        file.service,
        scope,
        r.storeRecordId,
        r.idKind,
        r.unit,
        r.acquisition,
        r.acquiredAt?.value ?? null,
        r.acquiredAt?.precision ?? null,
        now,
        now,
        complete ? now : null,
        file.adapterVersion,
      );
    }
    // Not seen in a complete scan: to review, never deleted. A partial scan never raises this,
    // and a scan with far fewer books waits for the owner to confirm.
    if (complete && (!preview.shrink || opts.confirmShrink)) {
      const ids = notSeenKeys(db, file, scope);
      const mark = db.prepare(
        'UPDATE store_purchases SET not_seen_since = ? WHERE id = ? AND not_seen_since IS NULL AND not_seen_kept = 0',
      );
      for (const id of ids) counts.notSeen += mark.run(now, id).changes;
    }
    db.prepare(
      `INSERT INTO store_import_runs (id, imported_at, service, account_scope, adapter_version,
         source, collected_at, completion, completion_reason, counts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      now,
      file.service,
      scope,
      file.adapterVersion,
      file.source,
      file.collectedAt,
      file.completion.status,
      file.completion.reason,
      JSON.stringify({ ...file.counts, ...counts }),
    );
    syncSeries(db);
    return counts;
  })();
}

/** Needs review rows: books a complete scan didn't find, still with that store copy. */
export function notSeenRows(
  db: DB,
): { id: string; purchaseId: string; itemId: string; service: Service; since: string }[] {
  return (
    db
      .prepare(
        `SELECT p.id, p.item_id, p.service, p.not_seen_since FROM store_purchases p
         WHERE p.not_seen_since IS NOT NULL AND p.not_seen_kept = 0
           AND EXISTS (SELECT 1 FROM locations l WHERE l.item_id = p.item_id AND l.kind = 'store'
             AND l.store = p.service)
         ORDER BY p.not_seen_since, p.id`,
      )
      .all() as { id: string; item_id: string; service: Service; not_seen_since: string }[]
  ).map((r) => ({
    id: `notseen:${r.id}`,
    purchaseId: r.id,
    itemId: r.item_id,
    service: r.service,
    since: r.not_seen_since,
  }));
}

/**
 * "Not seen in your latest Kindle scan": Keep (not asked again until it's seen and missed again)
 * or Remove the store copy. The repeat-import key stays, so a later scan doesn't add it back.
 */
export function actOnNotSeen(db: DB, purchaseId: string, action: 'keep' | 'remove'): void {
  const p = db
    .prepare('SELECT item_id, service FROM store_purchases WHERE id = ?')
    .get(purchaseId) as { item_id: string; service: string } | undefined;
  if (!p) throw new HttpError(404, 'No such store purchase.');
  db.transaction(() => {
    if (action === 'keep')
      db.prepare('UPDATE store_purchases SET not_seen_kept = 1 WHERE id = ?').run(purchaseId);
    else {
      db.prepare("DELETE FROM locations WHERE item_id = ? AND kind = 'store' AND store = ?").run(
        p.item_id,
        p.service,
      );
      db.prepare('DELETE FROM store_purchases WHERE id = ?').run(purchaseId);
    }
  })();
}

/** Diagnostics: the last import per store. Time, collector version, completeness, counts. */
export function lastStoreImports(db: DB): {
  service: string;
  importedAt: string;
  adapterVersion: string;
  completion: string;
  reason: string;
  counts: Record<string, unknown>;
}[] {
  return (
    db
      .prepare(
        `SELECT r.* FROM store_import_runs r WHERE r.imported_at = (SELECT MAX(x.imported_at)
           FROM store_import_runs x WHERE x.service = r.service) ORDER BY r.service`,
      )
      .all() as {
      service: string;
      imported_at: string;
      adapter_version: string;
      completion: string;
      completion_reason: string;
      counts: string;
    }[]
  ).map((r) => ({
    service: r.service,
    importedAt: r.imported_at,
    adapterVersion: r.adapter_version,
    completion: r.completion,
    reason: r.completion_reason,
    counts: parseJson<Record<string, unknown>>(r.counts, {}),
  }));
}
