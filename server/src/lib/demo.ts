import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/database.ts';
import { FakePlatform } from '../platform/fake.ts';
import { ATTR_OFFLINE, ATTR_RECALL_ON_DATA_ACCESS } from '../platform/types.ts';
import { addFolder } from '../scan/folders.ts';
import { ScanManager } from '../scan/scanManager.ts';
import { applyUserPatch, shortlistAdd } from './progress.ts';

/**
 * The demo library (DEMO=1, PLAN.md §17): clearly labelled, no keys, no owner files.
 * Every title is invented. Files are tiny stand-ins — enough for the light pass, which reads
 * names, sizes and attributes only. No ratings, ids or claims about real works.
 *
 * It shows the M1 cases: a book in several formats, an HD comic next to its standard version,
 * the same files in two folders (one copy online-only), separate editions, placeholder /
 * unknown / missing files, a disconnected drive, and some reading history.
 */

const ONLINE_ONLY = 0x20 | ATTR_RECALL_ON_DATA_ACCESS | ATTR_OFFLINE;

const DRIVE: Record<string, number> = {
  'Novels/glassharbor.epub': 412_000,
  'Novels/glassharbor.pdf': 1_830_000,
  'Novels/glassharbor.mobi': 520_000,
  'Novels/mapmakersdaughter.epub': 388_000,
  'Novels/thelanternkeepers_2ndedition.epub': 450_000,
  'Novels/thelanternkeepers_3rdedition.epub': 471_000,
  'Novels/riverofclocks.epub': 299_000,
  'Nonfiction/quietmornings_ahandbookforslowstarts.epub': 210_000,
  'Nonfiction/oldnotes.pdf': 90_000,
  'Tech/practicalwidgetcrafting_fourthedition.pdf': 9_400_000,
  'Tech/Widget Patterns - Ada Quill.pdf': 6_200_000,
  'Comics/Copperline/Copperline 001 (2019) (Digital).cbz': 31_000_000,
  'Comics/Copperline/Copperline 002 (2019) (Digital).cbz': 29_500_000,
  'Comics/Copperline/Copperline 004 (2019) (Digital).cbz': 30_200_000,
  'Comics/lanternfish_vol1.cbz': 88_000_000,
  'Comics/lanternfish_vol1_hd.cbz': 240_000_000,
  'Comics/tinyrobots_issue1.zip': 12_000_000,
  'Manga/Starfall Academy v01.cbz': 61_000_000,
  'Manga/Starfall Academy v02.cbz': 59_000_000,
  'Music/not-a-book.mp3': 4_000,
};

const CLOUD: Record<string, number> = {
  'Books/glassharbor.epub': 412_000, // same name + size as the drive copy: grouped as one item
  'Books/mapmakersdaughter.epub': 388_000,
  'Books/nightorchard.epub': 333_000,
  'Unsorted/fieldguidetopuddles.pdf': 2_100_000,
};

const SECOND_DRIVE: Record<string, number> = {
  'saltroadsongs.epub': 275_000,
};

function write(root: string, files: Record<string, number>) {
  for (const [rel, size] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Sizes are scaled down 1000x on disk; the demo only needs distinct, repeatable sizes.
    fs.writeFileSync(abs, Buffer.alloc(Math.max(1, Math.round(size / 1000)), 0x20));
  }
}

export async function buildDemoLibrary(db: DB, root: string): Promise<FakePlatform> {
  const drive = path.join(root, 'Demo external drive');
  const cloud = path.join(root, 'Demo iCloud Drive');
  const second = path.join(root, 'Demo second drive');
  write(drive, DRIVE);
  write(cloud, CLOUD);
  write(second, SECOND_DRIVE);

  const p = new FakePlatform();
  p.addVolume({
    volumeId: 'demo-drive',
    label: 'DEMO DRIVE',
    storageKind: 'external',
    root: drive,
  });
  p.addVolume({ volumeId: 'demo-cloud', label: 'DEMO ICLOUD', storageKind: 'cloud', root: cloud });
  const secondVol = p.addVolume({
    volumeId: 'demo-second',
    label: 'DEMO DRIVE 2',
    storageKind: 'external',
    root: second,
  });
  for (const rel of ['Books/glassharbor.epub', 'Books/nightorchard.epub']) {
    p.attributes.set(path.join(cloud, ...rel.split('/')), ONLINE_ONLY);
  }
  p.unreadableAttributeDirs.add(path.join(cloud, 'Unsorted'));

  const driveFolder = await addFolder(db, p, { path: drive });
  await addFolder(db, p, { path: cloud });
  await addFolder(db, p, { path: second });
  db.prepare('UPDATE folders SET also_in_icloud = 1 WHERE id = ?').run(driveFolder.id);

  const scans = new ScanManager(db, p);
  scans.start();
  await scans.wait();

  // A file that has since been deleted, and a drive that has since been unplugged.
  fs.rmSync(path.join(drive, 'Nonfiction', 'oldnotes.pdf'));
  scans.start();
  await scans.wait();
  secondVol.root = null;

  const byFile = (name: string) =>
    db
      .prepare(
        'SELECT x.item_id FROM item_files x JOIN files f ON f.id = x.file_id WHERE f.name = ? LIMIT 1',
      )
      .pluck()
      .get(name) as string;
  const today = new Date();
  const daysAgo = (n: number) =>
    new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);

  applyUserPatch(db, byFile('glassharbor.epub'), { progress: 'halfway' }, daysAgo(12));
  applyUserPatch(db, byFile('mapmakersdaughter.epub'), {
    progress: 'finished',
    finishedOn: daysAgo(40),
    finishedPrecision: 'exact',
    rating: 8,
    takeaway: 'Maps are arguments.',
  });
  applyUserPatch(db, byFile('Copperline 001 (2019) (Digital).cbz'), {
    progress: 'finished',
    finishedPrecision: 'unknown',
  });
  applyUserPatch(db, byFile('quietmornings_ahandbookforslowstarts.epub'), {
    progress: 'dnf',
    dnfReason: 'not_now',
  });
  applyUserPatch(db, byFile('practicalwidgetcrafting_fourthedition.pdf'), {
    kindOverride: 'tech',
    referenceOverride: true,
  });
  applyUserPatch(db, byFile('Widget Patterns - Ada Quill.pdf'), { kindOverride: 'tech' });
  applyUserPatch(db, byFile('Starfall Academy v01.cbz'), { kindOverride: 'manga' });
  applyUserPatch(db, byFile('Starfall Academy v02.cbz'), { kindOverride: 'manga' });
  applyUserPatch(db, byFile('thelanternkeepers_2ndedition.epub'), { icloudOverride: 'not_in' });
  shortlistAdd(db, byFile('thelanternkeepers_3rdedition.epub'));
  shortlistAdd(db, byFile('Starfall Academy v01.cbz'));
  shortlistAdd(db, byFile('nightorchard.epub'));
  return p;
}
