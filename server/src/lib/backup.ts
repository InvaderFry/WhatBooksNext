import { RESTORE_SNAPSHOTS_KEPT } from '../config.ts';
import { schemaVersion, type DB } from '../db/database.ts';
import { takeSnapshot } from '../db/snapshots.ts';
import { syncSeries } from '../identify/series.ts';
import { HttpError, nowIso } from '../util.ts';

/**
 * JSON backup and restore (PLAN.md §16). The backup holds everything except book files,
 * covers and secrets. Restore REPLACES all app data — it never merges — in one transaction,
 * after a pre-restore snapshot, and works without rescanning or connecting any drive.
 */

export const BACKUP_FORMAT = 'whatBooksNext-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Tables in the backup, parents before children (the order rows are inserted on restore). */
export const BACKUP_TABLES = [
  'settings',
  'folders',
  'series',
  'series_user',
  'items',
  'files',
  'item_files',
  'locations',
  'user_item',
  'id_aliases',
  'deletions',
  'file_user',
  'review_items',
  'item_matches',
  'lookup_state',
  'candidates_rejected',
  'review_state',
  'pick_feedback',
] as const;

/**
 * Tables a backup from an older schema may lack, with the schema version that added them.
 * Restoring such a backup leaves them empty. (M1 backups were made at version 1.)
 */
const ADDED_IN: Record<string, number> = {
  file_user: 2,
  review_items: 2,
  item_matches: 3,
  lookup_state: 3,
  candidates_rejected: 3,
  review_state: 3,
  pick_feedback: 3,
  series_user: 5,
};

/**
 * Tables deliberately left out. The backup-coverage test fails on any table that is in
 * neither list, so a new table can't be silently forgotten.
 */
export const BACKUP_EXCLUDED: Record<string, string> = {
  // Operational log of past scans; says nothing about the library or the owner.
  scan_runs: 'scan history only',
  // Which directories were completely listed, and when. Rebuilt by the next scan; restoring an
  // old one could make files look "missing" against a directory listing that is out of date.
  directory_scans: 'rebuilt by the next scan',
  // Raw source responses. Can be fetched again, and would make backups large. The matches
  // derived from them (item_matches) are in the backup, so recommendations survive a restore.
  source_cache: 'raw responses, fetched again when needed',
  // API keys and tokens never leave the PC in a backup or export (§6.3).
  secrets: 'API keys are never exported',
  // Operational log of past lookups, like scan_runs.
  enrich_runs: 'lookup history only',
};

export interface Backup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  note: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export function createBackup(db: DB): Backup {
  const tables: Backup['tables'] = {};
  db.transaction(() => {
    for (const t of BACKUP_TABLES)
      tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  })();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: schemaVersion(db),
    createdAt: nowIso(),
    note: 'API keys, book files, cover images and raw online-source responses are not included in this backup.',
    tables,
  };
}

function columnsOf(db: DB, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
}

/** Checks shape and columns before anything is touched. Throws a plain-language 400. */
export function validateBackup(db: DB, raw: unknown): Backup {
  if (!raw || typeof raw !== 'object')
    throw new HttpError(400, "That file isn't a whatBooksNext backup.");
  const b = raw as Partial<Backup>;
  if (b.format !== BACKUP_FORMAT)
    throw new HttpError(400, "That file isn't a whatBooksNext backup.");
  if (b.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new HttpError(
      400,
      `This backup uses format version ${b.formatVersion}; this app reads version ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  const current = schemaVersion(db);
  // Older backups restore: every column added since has a default (migrations must keep it so).
  if (
    typeof b.schemaVersion !== 'number' ||
    !Number.isInteger(b.schemaVersion) ||
    b.schemaVersion < 1 ||
    b.schemaVersion > current
  ) {
    throw new HttpError(
      400,
      `This backup was made with database version ${b.schemaVersion}; this app is at version ${current}. ` +
        'Update the app to restore it.',
    );
  }
  if (!b.tables || typeof b.tables !== 'object')
    throw new HttpError(400, 'The backup has no tables.');
  for (const t of BACKUP_TABLES) {
    if (b.tables[t] === undefined && (ADDED_IN[t] ?? 0) > b.schemaVersion) b.tables[t] = [];
    const rows = b.tables[t];
    if (!Array.isArray(rows)) throw new HttpError(400, `The backup is missing the "${t}" table.`);
    const cols = columnsOf(db, t);
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r))
        throw new HttpError(400, `A row in "${t}" is malformed.`);
      for (const k of Object.keys(r)) {
        if (!cols.has(k))
          throw new HttpError(400, `The "${t}" table in the backup has an unknown column "${k}".`);
      }
    }
  }
  for (const t of Object.keys(b.tables)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(t))
      throw new HttpError(400, `The backup has an unknown table "${t}".`);
  }
  return b as Backup;
}

export interface RestorePreview {
  createdAt: string;
  counts: { table: string; inBackup: number; now: number }[];
  /** Owner data edited after the backup was made — this would be lost. */
  changedSinceBackup: number;
}

export function previewRestore(db: DB, backup: Backup): RestorePreview {
  return {
    createdAt: backup.createdAt,
    counts: BACKUP_TABLES.map((t) => ({
      table: t,
      inBackup: backup.tables[t]!.length,
      now: db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number,
    })),
    changedSinceBackup: db
      .prepare('SELECT COUNT(*) FROM user_item WHERE updated_at > ?')
      .pluck()
      .get(backup.createdAt) as number,
  };
}

/**
 * Replaces all app data with the backup. A snapshot is taken first (kept apart from the
 * pre-migration ones). Any failure rolls the whole restore back.
 */
export async function restoreBackup(
  db: DB,
  backup: Backup,
  snapshotDir: string | null,
): Promise<{ snapshotPath: string | null }> {
  const snapshotPath = snapshotDir
    ? await takeSnapshot(db, snapshotDir, 'pre-restore', RESTORE_SNAPSHOTS_KEPT)
    : null;
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const t of [...BACKUP_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    // Old directory listings describe the replaced library; the next scan rebuilds them.
    db.prepare('DELETE FROM directory_scans').run();
    for (const t of BACKUP_TABLES) {
      const rows = backup.tables[t]!;
      if (rows.length === 0) continue;
      const stmtCache = new Map<string, ReturnType<DB['prepare']>>();
      for (const r of rows) {
        const keys = Object.keys(r).sort();
        const sig = keys.join(',');
        let stmt = stmtCache.get(sig);
        if (!stmt) {
          stmt = db.prepare(
            `INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`,
          );
          stmtCache.set(sig, stmt);
        }
        stmt.run(r);
      }
    }
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0)
      throw new HttpError(
        400,
        'The backup refers to records it does not contain; nothing was changed.',
      );
    // A backup from before series had their own rows (version < 5) has none: rebuild them
    // from the restored items, keeping any series ids the backup does hold.
    syncSeries(db);
  })();
  return { snapshotPath };
}
