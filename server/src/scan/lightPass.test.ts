import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../db/database.ts';
import type { FakePlatform } from '../platform/fake.ts';
import { ATTR_OFFLINE, ATTR_RECALL_ON_DATA_ACCESS } from '../platform/types.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from '../testing/helpers.ts';
import { addFolder, type FolderRow } from './folders.ts';
import { ScanManager } from './scanManager.ts';

let db: DB;
let drive: string;
let cloud: string;
let platform: FakePlatform;
let scans: ScanManager;

beforeEach(async () => {
  db = await memoryDb();
  drive = tempDir('wbn-drive-');
  cloud = tempDir('wbn-cloud-');
  platform = fakePlatformWithDrives({ drive, cloud });
  scans = new ScanManager(db, platform);
});

afterEach(() => {
  fs.rmSync(drive, { recursive: true, force: true });
  fs.rmSync(cloud, { recursive: true, force: true });
});

async function scan() {
  scans.start();
  return (await scans.wait())!;
}

const file = (name: string) =>
  db.prepare('SELECT * FROM files WHERE name = ?').get(name) as Record<string, unknown>;
const itemOf = (name: string) =>
  db
    .prepare('SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?')
    .pluck()
    .get(name) as string;
const itemCount = () => db.prepare('SELECT COUNT(*) FROM items').pluck().get() as number;
const unplug = (root: string) => {
  platform.volumes.find((v) => v.root === path.resolve(root))!.root = null;
};

describe('light pass', () => {
  it('lists book files with sizes and ignores other types, counting them', async () => {
    writeFiles(drive, { 'Novels/mapmaking.epub': 100, 'Music/track.mp3': 10, 'notes.txt': 5 });
    await addFolder(db, platform, { path: drive });
    const s = await scan();
    expect(file('mapmaking.epub')).toMatchObject({
      size: 100,
      availability: 'present',
      format: 'epub',
    });
    expect(s.folders[0]!.ignoredByType).toEqual({ mp3: 1, txt: 1 });
  });

  it('treats .zip and .rar as comic archives, as the owner confirmed', async () => {
    writeFiles(drive, { 'Comics/lanternfish_issue1.zip': 50, 'Comics/lanternfish_issue2.rar': 50 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(file('lanternfish_issue1.zip')).toMatchObject({ format: 'cbz' });
    expect(file('lanternfish_issue2.rar')).toMatchObject({ format: 'cbr' });
    expect(db.prepare('SELECT DISTINCT kind FROM items').pluck().all()).toEqual(['comic']);
  });

  it('marks files with recall or offline bits as placeholders, and unreadable attributes as unknown', async () => {
    writeFiles(cloud, { 'a/online.epub': 10, 'a/local.epub': 10, 'b/mystery.epub': 10 });
    platform.attributes.set(
      path.join(cloud, 'a', 'online.epub'),
      0x20 | ATTR_RECALL_ON_DATA_ACCESS | ATTR_OFFLINE,
    );
    platform.unreadableAttributeDirs.add(path.join(cloud, 'b'));
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(file('online.epub')!.availability).toBe('placeholder');
    expect(file('local.epub')!.availability).toBe('present');
    expect(file('mystery.epub')!.availability).toBe('unknown');
  });

  it('skips an unreachable folder and reports it, never treating it as empty', async () => {
    writeFiles(drive, { 'mapmaking.epub': 100 });
    await addFolder(db, platform, { path: drive });
    await scan();
    unplug(drive);
    const s = await scan();
    expect(s.folders[0]!.status).toBe('unreachable');
    expect(file('mapmaking.epub')).toMatchObject({ availability: 'present', stale: 0 });
  });

  it('finds a drive again after its letter (mount point) changes', async () => {
    writeFiles(drive, { 'mapmaking.epub': 100 });
    await addFolder(db, platform, { path: drive });
    await scan();
    const before = file('mapmaking.epub')!.id;
    const moved = tempDir('wbn-moved-');
    fs.cpSync(drive, moved, { recursive: true });
    platform.volumes.find((v) => v.label === 'drive')!.root = path.resolve(moved);
    const s = await scan();
    expect(s.folders[0]!.status).toBe('completed');
    expect(file('mapmaking.epub')).toMatchObject({ id: before, availability: 'present' });
    fs.rmSync(moved, { recursive: true, force: true });
  });

  it('marks a deleted file missing, keeps its item, and makes it present again when it returns', async () => {
    writeFiles(drive, { 'Novels/mapmaking.epub': 100 });
    await addFolder(db, platform, { path: drive });
    await scan();
    const item = itemOf('mapmaking.epub');
    fs.rmSync(path.join(drive, 'Novels', 'mapmaking.epub'));
    await scan();
    expect(file('mapmaking.epub')!.availability).toBe('missing');
    expect(itemOf('mapmaking.epub')).toBe(item);
    writeFiles(drive, { 'Novels/mapmaking.epub': 100 });
    const s = await scan();
    expect(file('mapmaking.epub')!.availability).toBe('present');
    expect(s.folders[0]!.returned).toBe(1);
  });

  it('marks files missing when their whole directory was deleted', async () => {
    writeFiles(drive, { 'Old/Deep/mapmaking.epub': 100, 'keep.epub': 5 });
    await addFolder(db, platform, { path: drive });
    await scan();
    fs.rmSync(path.join(drive, 'Old'), { recursive: true });
    await scan();
    expect(file('mapmaking.epub')!.availability).toBe('missing');
  });
});

describe('scenario 10: cancelling, access errors and unplugging never mark unlisted files missing', () => {
  beforeEach(() => {
    writeFiles(drive, { 'A/one.epub': 10, 'B/two.epub': 10, 'C/three.epub': 10 });
  });

  it('leaves files in a directory that failed to list untouched, flagged stale', async () => {
    await addFolder(db, platform, { path: drive });
    await scan();
    platform.failingDirs.add(path.join(drive, 'B'));
    fs.rmSync(path.join(drive, 'B', 'two.epub')); // even if it really is gone, we didn't see that
    const s = await scan();
    expect(s.folders[0]!.status).toBe('partial');
    expect(file('two.epub')).toMatchObject({ availability: 'present', stale: 1 });
    expect(file('one.epub')).toMatchObject({ availability: 'present', stale: 0 });
  });

  it('leaves unlisted directories untouched when the drive is unplugged halfway', async () => {
    await addFolder(db, platform, { path: drive });
    await scan();
    let listed = 0;
    platform.onListDirectory = () => {
      if (++listed === 3) fs.renameSync(drive, drive + '-gone'); // pulled out after the root and one subfolder
    };
    await scan();
    fs.renameSync(drive + '-gone', drive);
    const rows = db.prepare('SELECT name, availability, stale FROM files').all() as {
      availability: string;
      stale: number;
    }[];
    expect(rows.filter((r) => r.availability === 'missing')).toEqual([]);
    expect(rows.filter((r) => r.stale === 1).length).toBe(2);
  });

  it('leaves unlisted directories untouched when the scan is cancelled, and says so', async () => {
    await addFolder(db, platform, { path: drive });
    await scan();
    for (const n of ['A/one.epub', 'B/two.epub', 'C/three.epub'])
      fs.rmSync(path.join(drive, ...n.split('/')));
    platform.onListDirectory = () => scans.requestCancel();
    const s = await scan();
    expect(s.status).toBe('cancelled');
    const missing = db
      .prepare("SELECT COUNT(*) FROM files WHERE availability = 'missing'")
      .pluck()
      .get();
    expect(missing).toBe(0);
    expect(
      (db.prepare('SELECT last_complete_scan_at FROM folders').get() as FolderRow)
        .last_complete_scan_at,
    ).not.toBeNull();
  });

  it('does not reset the last complete scan date after a partial scan', async () => {
    await addFolder(db, platform, { path: drive });
    await scan();
    const first = db.prepare('SELECT last_complete_scan_at FROM folders').pluck().get() as string;
    platform.failingDirs.add(path.join(drive, 'A'));
    await new Promise((r) => setTimeout(r, 5));
    await scan();
    expect(db.prepare('SELECT last_complete_scan_at FROM folders').pluck().get()).toBe(first);
  });
});

describe('grouping by name and size (§11.3 rules 1–2)', () => {
  it('groups an EPUB + PDF + MOBI trio in one folder into one item (scenario 17, M1 level)', async () => {
    writeFiles(drive, {
      'Bundle/mapmaking.epub': 100,
      'Bundle/mapmaking.pdf': 300,
      'Bundle/mapmaking.mobi': 90,
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
    const primary = db
      .prepare(
        'SELECT f.name FROM item_files x JOIN files f ON f.id = x.file_id WHERE is_primary = 1',
      )
      .pluck()
      .get();
    expect(primary).toBe('mapmaking.epub');
  });

  it('groups an HD and a standard comic in one folder, with the HD file as primary', async () => {
    writeFiles(drive, { 'C/lanternfish_vol1.cbz': 100, 'C/lanternfish_vol1_hd.cbz': 400 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
    const primary = db
      .prepare(
        'SELECT f.name FROM item_files x JOIN files f ON f.id = x.file_id WHERE is_primary = 1',
      )
      .pluck()
      .get();
    expect(primary).toBe('lanternfish_vol1_hd.cbz');
  });

  it('groups copies with the same name and size in different folders, chaining with format groups', async () => {
    writeFiles(drive, { 'Books/mapmaking.epub': 100, 'Books/mapmaking.pdf': 300 });
    writeFiles(cloud, { 'Backup/mapmaking.epub': 100, 'Backup/mapmaking.pdf': 300 });
    platform.attributes.set(
      path.join(cloud, 'Backup', 'mapmaking.epub'),
      0x20 | ATTR_RECALL_ON_DATA_ACCESS,
    );
    platform.attributes.set(
      path.join(cloud, 'Backup', 'mapmaking.pdf'),
      0x20 | ATTR_RECALL_ON_DATA_ACCESS,
    );
    await addFolder(db, platform, { path: drive });
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(itemCount()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM item_files').pluck().get()).toBe(4);
  });

  it('groups copies inside the same folder too (the M0 probe found 262 such groups)', async () => {
    writeFiles(drive, { 'One/mapmaking.epub': 100, 'Two/mapmaking.epub': 100 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
  });

  it('never groups same-named files whose sizes differ', async () => {
    writeFiles(drive, { 'One/mapmaking.epub': 100, 'Two/mapmaking.epub': 101 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it('never groups an EPUB here and a PDF in another folder (a suggestion for later, not a merge)', async () => {
    writeFiles(drive, { 'One/mapmaking.epub': 100, 'Two/mapmaking.pdf': 300 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it('never groups different edition numbers, even in one folder (scenario 24, filename level)', async () => {
    writeFiles(drive, {
      'Tech/pythonrecipes_2ndedition.pdf': 100,
      'Tech/pythonrecipes_3rdedition.epub': 100,
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it('never groups empty files by name and size', async () => {
    writeFiles(drive, { 'One/blank.pdf': 0, 'Two/blank.pdf': 0 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it("keeps a book's item when its file moves to another folder (same name and size)", async () => {
    writeFiles(drive, { 'Inbox/mapmaking.epub': 100 });
    await addFolder(db, platform, { path: drive });
    await scan();
    const item = itemOf('mapmaking.epub');
    fs.mkdirSync(path.join(drive, 'Sorted'));
    fs.renameSync(
      path.join(drive, 'Inbox', 'mapmaking.epub'),
      path.join(drive, 'Sorted', 'mapmaking.epub'),
    );
    await scan();
    const items = db
      .prepare(
        'SELECT DISTINCT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ?',
      )
      .pluck()
      .all('mapmaking.epub');
    expect(items).toEqual([item]);
    expect(itemCount()).toBe(1);
    const primary = db
      .prepare(
        'SELECT f.rel_path FROM item_files x JOIN files f ON f.id = x.file_id WHERE is_primary = 1',
      )
      .pluck()
      .get();
    expect(primary).toBe('Sorted/mapmaking.epub');
  });
});

describe('re-reading names after the parser improves (§9.2 "Refresh")', () => {
  it("refreshes titles read by an older parser, and never touches the owner's own title", async () => {
    writeFiles(drive, {
      'Manga/Starfall Academy Manga - 12 [grp].zip': 10,
      'Manga/Starfall Academy Manga - 13 [grp].zip': 11,
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    // Pretend both were read by an older parser that got the titles wrong.
    db.prepare("UPDATE files SET stages = '{}'").run();
    db.prepare("UPDATE items SET title = 'wrong'").run();
    const owned = itemOf('Starfall Academy Manga - 13 [grp].zip');
    db.prepare(
      "INSERT INTO user_item (item_id, title_override, updated_at) VALUES (?, 'My own title', 'x')",
    ).run(owned);

    const s = await scan();
    expect(s.folders[0]!.reparsed).toBe(2);
    const titles = db.prepare('SELECT title FROM items ORDER BY title').pluck().all();
    expect(titles).toEqual(['Starfall Academy Manga Vol. 12', 'Starfall Academy Manga Vol. 13']);
    expect(
      db.prepare('SELECT title_override FROM user_item WHERE item_id = ?').pluck().get(owned),
    ).toBe('My own title');

    const again = await scan();
    expect(again.folders[0]!.reparsed).toBe(0); // read once per parser version, not every scan
  });
});

describe('folder names that change only in case (Windows ignores case)', () => {
  it('still marks a deleted file missing after its folder was renamed CaseFolder -> casefolder', async () => {
    writeFiles(drive, { 'CaseFolder/separate.epub': 10, 'CaseFolder/keep.epub': 11 });
    await addFolder(db, platform, { path: drive });
    await scan();
    fs.renameSync(path.join(drive, 'CaseFolder'), path.join(drive, 'casefolder-tmp'));
    fs.renameSync(path.join(drive, 'casefolder-tmp'), path.join(drive, 'casefolder'));
    fs.rmSync(path.join(drive, 'casefolder', 'separate.epub'));
    await scan();
    expect(file('separate.epub')).toMatchObject({ availability: 'missing', stale: 0 });
    expect(file('keep.epub')).toMatchObject({
      availability: 'present',
      stale: 0,
      rel_dir: 'casefolder',
    });
  });
});

describe('title words are never mistaken for quality tags', () => {
  it('keeps road_to_low_orbit and road_to_orbit in one folder as two books', async () => {
    writeFiles(drive, { 'Novels/road_to_low_orbit.epub': 10, 'Novels/road_to_orbit.pdf': 20 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it('groups "Map Making optimized.pdf" with "Map Making.epub"', async () => {
    writeFiles(drive, { 'Novels/Map Making optimized.pdf': 10, 'Novels/Map Making.epub': 20 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
  });

  it('keeps "The High Road" and "The Road" in one folder as two books', async () => {
    writeFiles(drive, { 'Novels/The High Road.epub': 10, 'Novels/The Road.pdf': 20 });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });
});
