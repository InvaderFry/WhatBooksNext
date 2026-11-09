import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../testing/helpers.ts';
import {
  MigrationError,
  loadMigrations,
  migrate,
  openDatabase,
  schemaVersion,
} from './database.ts';
import { listSnapshots, pruneSnapshots } from './snapshots.ts';

let dir: string;
beforeEach(() => {
  dir = tempDir('wbn-db-');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('migrations and snapshots (§6.2)', () => {
  it('applies every migration to a new database without a snapshot', async () => {
    const db = openDatabase(path.join(dir, 'a.sqlite'));
    const r = await migrate(db, { snapshotDir: path.join(dir, 'snap') });
    expect(r.from).toBe(0);
    expect(schemaVersion(db)).toBe(loadMigrations().at(-1)!.version);
    expect(r.snapshotPath).toBeNull();
    db.close();
  });

  it('snapshots a database with data before migrating it, and the snapshot opens with the old data', async () => {
    const file = path.join(dir, 'b.sqlite');
    const db = openDatabase(file);
    await migrate(db, { snapshotDir: null });
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'now')").run();
    const next = [
      ...loadMigrations(),
      { version: 999, name: '999_test.sql', sql: 'CREATE TABLE extra (x INTEGER);' },
    ];
    const r = await migrate(db, { snapshotDir: path.join(dir, 'snap'), migrations: next });
    expect(r.snapshotPath).toMatch(/pre-migration-v1-/);
    const snap = openDatabase(r.snapshotPath!);
    expect(snap.prepare('SELECT value FROM settings').pluck().get()).toBe('1');
    expect(schemaVersion(snap)).toBe(1);
    snap.close();
    db.close();
  });

  it('rolls back a failed migration and reports which snapshot to restore', async () => {
    const db = openDatabase(path.join(dir, 'c.sqlite'));
    await migrate(db, { snapshotDir: null });
    const bad = [
      ...loadMigrations(),
      { version: 2, name: '002_bad.sql', sql: 'CREATE TABLE ok (x); THIS IS NOT SQL;' },
    ];
    const err = await migrate(db, { snapshotDir: path.join(dir, 'snap'), migrations: bad }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.snapshotPath).toMatch(/pre-migration-v1-/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    db.close();
  });

  it('keeps the newest 5 migration snapshots without touching restore snapshots', () => {
    const snap = path.join(dir, 'snap');
    fs.mkdirSync(snap);
    for (let i = 0; i < 7; i++)
      fs.writeFileSync(
        path.join(snap, `pre-migration-v${i}-2026-01-0${i + 1}T00-00-00-000Z.sqlite`),
        '',
      );
    for (let i = 0; i < 3; i++)
      fs.writeFileSync(path.join(snap, `pre-restore-2026-01-0${i + 1}T00-00-00-000Z.sqlite`), '');
    pruneSnapshots(snap, 'pre-migration-v9', 5);
    const kinds = listSnapshots(snap).map((s) => s.kind);
    expect(kinds.filter((k) => k === 'pre-migration')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'pre-restore')).toHaveLength(3);
  });
});
