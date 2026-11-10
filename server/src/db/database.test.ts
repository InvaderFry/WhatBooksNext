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

/** The M1 schema, as the owner's database was before M2. */
const v1 = loadMigrations().slice(0, 1);

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
    await migrate(db, { snapshotDir: null, migrations: v1 });
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'now')").run();
    const next = [
      ...v1,
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
    await migrate(db, { snapshotDir: null, migrations: v1 });
    const bad = [
      ...v1,
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

  it("upgrades a version-1 database with the owner's data to the latest version, keeping it", async () => {
    const db = openDatabase(path.join(dir, 'd.sqlite'));
    await migrate(db, { snapshotDir: null, migrations: v1 });
    db.prepare(
      "INSERT INTO items (id, title, created_at, updated_at) VALUES ('i1', 'Kept', 'now', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO user_item (item_id, progress, updated_at) VALUES ('i1', 'halfway', 'now')",
    ).run();
    const r = await migrate(db, { snapshotDir: path.join(dir, 'snap-d') });
    expect(r.from).toBe(1);
    expect(r.to).toBe(loadMigrations().at(-1)!.version);
    expect(db.prepare('SELECT progress FROM user_item').pluck().get()).toBe('halfway');
    expect(db.prepare('SELECT title_source FROM items').pluck().get()).toBeNull();
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

describe('migration 011 (first complete scan)', () => {
  it('keeps the old one-day answer for folders scanned before it existed', async () => {
    const db = openDatabase(':memory:');
    const all = loadMigrations();
    await migrate(db, { snapshotDir: null, migrations: all.filter((m) => m.version <= 10) });
    const now = '2026-01-01T10:00:00.000Z';
    db.prepare(
      `INSERT INTO folders (id, display_path, relative_path, storage_kind, also_in_icloud,
         last_seen_at, last_complete_scan_at, created_at, updated_at)
       VALUES ('f', 'X:\\\\Books', '', 'local', 0, ?, ?, ?, ?)`,
    ).run(now, '2026-03-01T00:00:00.000Z', now, now);
    db.prepare(
      `INSERT INTO folders (id, display_path, relative_path, storage_kind, also_in_icloud,
         last_seen_at, last_complete_scan_at, created_at, updated_at)
       VALUES ('g', 'X:\\\\Never', '', 'local', 0, ?, NULL, ?, ?)`,
    ).run(now, now, now);
    const file = db.prepare(
      `INSERT INTO files (id, folder_id, rel_path, rel_dir, name, ext, format, size, compare_key,
         first_seen_at, last_seen_at, availability)
       VALUES (?, 'f', ?, '', ?, 'epub', 'epub', 1, ?, ?, ?, 'present')`,
    );
    file.run('a', 'a.epub', 'a.epub', 'a', '2026-01-01T10:00:05.000Z', now);
    file.run('b', 'b.epub', 'b.epub', 'b', '2026-01-01T12:00:00.000Z', now);
    file.run('c', 'c.epub', 'c.epub', 'c', '2026-02-01T10:00:00.000Z', now);
    await migrate(db, { snapshotDir: null, migrations: all });
    const first = (id: string) =>
      db.prepare('SELECT first_complete_scan_at FROM folders WHERE id = ?').pluck().get(id);
    expect(first('f')).toBe('2026-01-01T12:00:00.000Z');
    expect(first('g')).toBeNull();
  });
});
