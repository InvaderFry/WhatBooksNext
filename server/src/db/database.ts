import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATION_SNAPSHOTS_KEPT } from '../config.ts';
import { takeSnapshot } from './snapshots.ts';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Numbered SQL migrations, `NNN_name.sql`, in order (§6.2). */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 3)),
      name: f,
      sql: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export class MigrationError extends Error {
  readonly snapshotPath: string | null;
  readonly failedMigration: string;
  constructor(message: string, failedMigration: string, snapshotPath: string | null) {
    super(message);
    this.name = 'MigrationError';
    this.failedMigration = failedMigration;
    this.snapshotPath = snapshotPath;
  }
}

export function openDatabase(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Applies pending migrations, each in its own transaction. Before migrating a database that
 * already has data, takes a consistent snapshot with the SQLite Online Backup API (§6.2).
 * If a migration fails it rolls back and throws: the caller must not start normally.
 */
export async function migrate(
  db: DB,
  opts: { snapshotDir: string | null; migrations?: Migration[] },
): Promise<{ from: number; to: number; snapshotPath: string | null }> {
  const migrations = opts.migrations ?? loadMigrations();
  const from = schemaVersion(db);
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, snapshotPath: null };

  let snapshotPath: string | null = null;
  if (from > 0 && opts.snapshotDir) {
    snapshotPath = await takeSnapshot(
      db,
      opts.snapshotDir,
      `pre-migration-v${from}`,
      MIGRATION_SNAPSHOTS_KEPT,
    );
  }

  for (const m of pending) {
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      throw new MigrationError(
        `Migration ${m.name} failed: ${(err as Error).message}`,
        m.name,
        snapshotPath,
      );
    }
  }
  return { from, to: pending.at(-1)!.version, snapshotPath };
}

/** Every table in the schema (used by the backup-coverage test, §16). */
export function listTables(db: DB): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}
