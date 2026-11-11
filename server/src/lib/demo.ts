import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../util.ts';
import type { DB } from '../db/database.ts';
import { FakePlatform } from '../platform/fake.ts';
import { ATTR_OFFLINE, ATTR_RECALL_ON_DATA_ACCESS } from '../platform/types.ts';
import { addFolder } from '../scan/folders.ts';
import { ScanManager } from '../scan/scanManager.ts';
import {
  makeCbr,
  makeCbz,
  makeEpub,
  makeImage,
  makePdf,
  makeZip,
  textLines,
} from '../testing/fixtures.ts';
import { fillerFor } from '../testing/helpers.ts';
import { LookupManager } from '../identify/lookups.ts';
import { Sources } from '../sources/index.ts';
import { addCoverage, setSuggestedCoverage } from './coverage.ts';
import { createStoreItem } from './store.ts';
import { applyUserPatch, ensureUserRow, shortlistAdd } from './progress.ts';
import { newId } from '../util.ts';

/**
 * The demo library (DEMO=1, PLAN.md §17): clearly labelled, no keys, no owner files. Every
 * title, author and word is invented, and the files are generated here — real EPUBs, CBZs,
 * CBRs and PDFs, so the deep pass reads them like any other. No ratings, ids or claims about
 * real works.
 *
 * It shows the M1 and M2 cases: a book in several formats, an HD comic next to its standard
 * version, the same files in two folders (one copy online-only), separate editions, a
 * translation split from its original, text / comic / scanned / uncertain PDFs, files that
 * can't be read, an archive that isn't a comic, a cross-folder suggestion, placeholder /
 * unknown / missing files, a disconnected drive, and some reading history.
 *
 * M3: lookups run against the demo source only (sources/demo.ts — invented works, labelled as
 * such, never online), so the demo shows ratings, an unconfirmed match, a tie to settle and
 * books left unidentified, and Read next has real reasons to give.
 */

const ONLINE_ONLY = 0x20 | ATTR_RECALL_ON_DATA_ACCESS | ATTR_OFFLINE;

const words = (n: number) => Array.from({ length: Math.ceil(n / 1500) }, () => 1500);
const textPdf = (pages: number, seed: number, info?: Record<string, string>) =>
  makePdf({
    pages: Array.from({ length: pages }, (_, i) => ({ text: textLines(40, seed + i) })),
    info,
  });
const comicPdf = (pages: number, color: string) =>
  makePdf({
    pages: Array.from({ length: pages }, () => ({ image: makeImage(400, 615, 'jpeg', color) })),
    width: 400,
    height: 615,
  });
const greyPdf = (pages: number, hiddenText: boolean) =>
  makePdf({
    pages: Array.from({ length: pages }, (_, i) => ({
      image: makeImage(420, 640, 'jpeg', '#000', true),
      imageGray: true,
      hiddenText: hiddenText ? textLines(40, 50 + i) : undefined,
    })),
    width: 420,
    height: 640,
  });

function driveFiles(): Record<string, Buffer> {
  const glass = makeEpub({
    title: 'Glass Harbor',
    creators: ['Mira Vantongeren'],
    language: 'en',
    publisher: 'Demo Press',
    subjects: ['Fiction', 'Sea stories'],
    description: 'A lighthouse keeper finds a harbor made of glass. (Invented for the demo.)',
    chapters: words(96_000),
    cover: true,
    seed: 1,
  });
  return {
    'Novels/glassharbor.epub': glass,
    'Novels/glassharbor.pdf': textPdf(12, 1),
    'Novels/glassharbor.mobi': fillerFor('glassharbor.mobi', 520_000),
    'Novels/mapmakersdaughter.epub': mapmaker,
    'Novels/thelanternkeepers_2ndedition.epub': makeEpub({
      title: 'The Lantern Keepers',
      creators: ['Odile Brannagh'],
      language: 'en',
      chapters: words(71_000),
      cover: true,
      seed: 3,
    }),
    'Novels/thelanternkeepers_3rdedition.epub': makeEpub({
      title: 'The Lantern Keepers',
      creators: ['Odile Brannagh'],
      language: 'en',
      chapters: words(74_500),
      cover: true,
      seed: 4,
    }),
    'Novels/riverofclocks.epub': makeEpub({
      title: 'River of Clocks',
      creators: ['Tamsin Achterberg'],
      language: 'en',
      series: 'The Clockwater Books',
      seriesIndex: '1',
      chapters: words(58_000),
      cover: true,
      seed: 5,
    }),
    // The second of a three-book series whose third isn't owned (§12.5: "2 of 3 owned").
    'Novels/thetinkersclock.epub': makeEpub({
      title: 'The Tinker’s Clock',
      creators: ['Tamsin Achterberg'],
      language: 'en',
      series: 'The Clockwater Books',
      seriesIndex: '2',
      chapters: words(61_000),
      cover: true,
      seed: 13,
    }),
    // A translation in the same folder: grouped by name first, then split by language.
    'Translations/saltandember.epub': makeEpub({
      title: 'Salt and Ember',
      creators: ['Inés Corvalán'],
      language: 'en',
      chapters: words(40_000),
      seed: 6,
    }),
    'Translations/saltandember_hq.epub': makeEpub({
      title: 'Sal y brasa',
      creators: ['Inés Corvalán'],
      language: 'es',
      chapters: words(42_000),
      seed: 7,
    }),
    'Nonfiction/quietmornings_ahandbookforslowstarts.epub': makeEpub({
      title: 'Quiet Mornings: A Handbook for Slow Starts',
      creators: ['Bertil Haaland'],
      language: 'en',
      chapters: words(31_000),
      cover: true,
      seed: 8,
    }),
    'Nonfiction/oldnotes.pdf': textPdf(3, 9),
    'Nonfiction/damagedcopy.epub': Buffer.from('This file was cut short during a download.'),
    'Tech/practicalwidgetcrafting_fourthedition.pdf': textPdf(14, 10, {
      Title: 'Practical Widget Crafting',
      Author: 'Lio Sandoval',
    }),
    'Tech/Widget Patterns - Ada Quill.pdf': textPdf(10, 20, {
      Title: 'Widget Patterns',
      Author: 'Ada Quill',
    }),
    // A tech book tied to one version of a (real) language: first in Still relevant? (§13.10).
    // The title and author are invented; nothing is claimed about any real book.
    'Tech/widgetrecipesforpython2.pdf': textPdf(8, 60, {
      Title: 'Widget Recipes for Python 2',
      Author: 'Mags Oduya',
    }),
    ...Object.fromEntries(
      [1, 2, 4, 7].map((n) => [
        `Comics/Copperline/Copperline 00${n} (2019) (Digital).cbz`,
        makeCbz({
          pages: 22,
          comicInfo: {
            Series: 'Copperline',
            Number: String(n),
            Year: '2019',
            Writer: 'Rue Fenwick',
          },
        }),
      ]),
    ),
    // Collected editions of Copperline: volume 1 (issues 1–4, confirmed below) and volume 2
    // (5–8, only suggested), so one gap is covered and one "may be covered" (§12.5).
    'Comics/Copperline/Copperline Vol. 1 (2020).cbz': makeCbz({ pages: 12 }),
    'Comics/Copperline/Copperline Vol. 2 (2021).cbz': makeCbz({ pages: 14 }),
    'Comics/lanternfish_vol1.cbz': makeCbz({ pages: 8 }),
    'Comics/lanternfish_vol1_hd.cbz': makeCbz({ pages: 8, width: 320, height: 490 }),
    'Comics/tinyrobots_issue1.zip': makeCbz({ pages: 6 }),
    'Comics/tinyrobots_issue2.rar': makeCbr({ pages: 6 }),
    'Comics/shadowservice_vol1_darkarts.pdf': comicPdf(6, '#1f6f8b'),
    'Comics/software_bundle.zip': makeZip([
      { name: 'setup.exe', data: fillerFor('setup.exe', 4000) },
      { name: 'readme.txt', data: 'Not a comic.' },
      { name: 'licence.pdf', data: fillerFor('licence.pdf', 3000) },
    ]),
    'Scans/harborgazette1952.pdf': greyPdf(5, true),
    'Scans/inkandsilence.pdf': greyPdf(5, false),
    ...Object.fromEntries(
      [1, 2].map((n) => [
        `Manga/Starfall Academy v0${n}.cbz`,
        makeCbz({
          pages: 10,
          comicInfo: {
            Series: 'Starfall Academy',
            Number: String(n),
            Manga: 'YesAndRightToLeft',
            Writer: 'Kaede Morishita',
          },
        }),
      ]),
    ),
    'Music/not-a-book.mp3': fillerFor('not-a-book.mp3', 4000),
  };
}

const mapmaker = makeEpub({
  title: 'The Mapmaker’s Daughter',
  creators: ['Hollis Quarrender'],
  language: 'en',
  chapters: words(83_000),
  cover: true,
  seed: 2,
});

function cloudFiles(drive: Record<string, Buffer>): Record<string, Buffer> {
  return {
    // Exact copies of drive files: grouped as one item.
    'Books/glassharbor.epub': drive['Novels/glassharbor.epub']!,
    'Books/mapmakersdaughter.epub': drive['Novels/mapmakersdaughter.epub']!,
    'Books/nightorchard.epub': makeEpub({
      title: 'Night Orchard',
      creators: ['Petra Lindqvist-Arno'],
      language: 'en',
      chapters: words(60_000),
      seed: 11,
    }),
    // Only a PDF here, an EPUB on the drive: suggested as one book, never grouped silently.
    'Books/riverofclocks.pdf': textPdf(9, 30),
    'Unsorted/fieldguidetopuddles.pdf': textPdf(4, 40),
  };
}

function write(root: string, files: Record<string, Buffer>) {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

export async function buildDemoLibrary(
  db: DB,
  root: string,
  coversDir: string | null = null,
): Promise<FakePlatform> {
  const drive = path.join(root, 'Demo external drive');
  const cloud = path.join(root, 'Demo iCloud Drive');
  const second = path.join(root, 'Demo second drive');
  const d = driveFiles();
  write(drive, d);
  write(cloud, cloudFiles(d));
  write(second, {
    'saltroadsongs.epub': makeEpub({
      title: 'Salt Road Songs',
      creators: ['Anouk Teversham'],
      chapters: words(52_000),
      seed: 12,
    }),
  });

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

  const scans = new ScanManager(db, p, { coversDir });
  try {
    scans.start();
    await scans.wait();

    // A file that has since been deleted, and a drive that has since been unplugged.
    fs.rmSync(path.join(drive, 'Nonfiction', 'oldnotes.pdf'));
    scans.start();
    await scans.wait();
  } finally {
    await scans.close();
  }
  secondVol.root = null;
  // The unplugged drive was last scanned a month ago, so the scan reminder shows (§9.7).
  db.prepare('UPDATE folders SET last_complete_scan_at = ? WHERE volume_id = ?').run(
    new Date(Date.now() - 34 * 86_400_000).toISOString(),
    'demo-second',
  );

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
  applyUserPatch(db, byFile('thelanternkeepers_2ndedition.epub'), { icloudOverride: 'not_in' });
  applyUserPatch(db, byFile('saltroadsongs.epub'), { triage: 'want' });
  applyUserPatch(db, byFile('Widget Patterns - Ada Quill.pdf'), { triage: 'maybe' });

  // M5: modes and taste (§13.10, §13.11, §17 "enough rated/finished/DNF history for taste
  // learning to switch on").
  applyUserPatch(db, byFile('widgetrecipesforpython2.pdf'), { kindOverride: 'tech' });
  // When the owner says they got two books, so Waiting on your shelf has dates to go by (the
  // demo's files all share one copy date, which counts as unknown).
  db.prepare('UPDATE user_item SET acquired_on = ?, acquired_precision = ? WHERE item_id = ?').run(
    '2019-06',
    'approximate',
    byFile('saltroadsongs.epub'),
  );
  ensureUserRow(db, byFile('Widget Patterns - Ada Quill.pdf'));
  db.prepare('UPDATE user_item SET acquired_on = ?, acquired_precision = ? WHERE item_id = ?').run(
    '2021-03-14',
    'exact',
    byFile('Widget Patterns - Ada Quill.pdf'),
  );
  // A book started months ago and not touched since: Still reading? asks about it.
  const stalled = byFile('saltandember.epub');
  applyUserPatch(db, stalled, { progress: 'sampled' }, daysAgo(130));
  db.prepare('UPDATE user_item SET progress_at = ? WHERE item_id = ?').run(
    new Date(today.getTime() - 130 * 86_400_000).toISOString(),
    stalled,
  );
  addHistory(db);

  const lookups = new LookupManager(db, new Sources(db, { demo: true }));
  lookups.start();
  await lookups.wait();

  // What the Copperline collections hold: one confirmed by the owner, one only suggested by the
  // (invented) demo source.
  const copperline = db
    .prepare('SELECT series_id FROM items WHERE id = ?')
    .pluck()
    .get(byFile('Copperline 002 (2019) (Digital).cbz')) as string;
  addCoverage(db, byFile('Copperline Vol. 1 (2020).cbz'), copperline, 1, 4);
  setSuggestedCoverage(db, byFile('Copperline Vol. 2 (2021).cbz'), 'demo', [
    { seriesId: copperline, first: 5, last: 8 },
  ]);

  // An ongoing story has more published volumes than the two owned collections.
  db.prepare(
    `INSERT INTO series_publications (series_id, source, source_series_id, anchor_book_id, anchor_key, entries, checked_at)
    VALUES (?, 'demo', 'demo-copperline-volumes', 'demo-trade-1', 'demo', ?, ?)`,
  ).run(
    copperline,
    JSON.stringify(
      [1, 2, 3, 4].map((position) => ({
        position,
        title: `Copperline Vol. ${position}`,
        sourceId: `demo-trade-${position}`,
        publishedOn: `${2020 + position}-01-01`,
      })),
    ),
    nowIso(),
  );

  // Books owned in store apps (§14): one the owner can read on the iPad, one not confirmed.
  // The Kindle one has a link to read it there (Store links). Its ID is invented and isn't in
  // Amazon's form, so it can't point to a real book.
  createStoreItem(db, {
    title: 'The Cartographer of Small Rains',
    author: 'Wenna Holloway',
    kind: 'fiction',
    store: 'kindle',
    readable: false,
    link: { url: 'https://read.amazon.com/?asin=INVENTED-DEMO-1', kind: 'read' },
  });
  createStoreItem(db, {
    title: 'A Field Guide to Quiet Machines',
    author: 'Tobiah Renn',
    kind: 'nonfiction',
    store: 'apple_books',
    readable: true,
  });

  shortlistAdd(db, byFile('thelanternkeepers_3rdedition.epub'));
  shortlistAdd(db, byFile('Starfall Academy v01.cbz'));
  shortlistAdd(db, byFile('nightorchard.epub'));

  return p;
}

/**
 * Reading done elsewhere (history-only, §7): invented titles and authors. Enough rated,
 * finished and "Not for me" outcomes, from several authors, for taste learning to switch on —
 * and to lift the owned books of an author rated highly here.
 */
function addHistory(db: DB): void {
  /** "YYYY-MM", n months before this one: a month, honestly approximate. */
  const monthsAgo = (n: number) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const books: {
    title: string;
    author: string;
    kind: 'fiction' | 'comic' | 'self_help' | 'nonfiction';
    rating?: number;
    dnf?: boolean;
    /** Months ago it was finished (so Stats has years to show); unknown when absent. */
    monthsAgo?: number;
  }[] = [
    {
      title: 'The Ferryman’s Almanac',
      author: 'Odile Brannagh',
      kind: 'fiction',
      rating: 9,
      monthsAgo: 2,
    },
    {
      title: 'Lamps Along the Weir',
      author: 'Odile Brannagh',
      kind: 'fiction',
      rating: 10,
      monthsAgo: 14,
    },
    { title: 'A Winter of Wicks', author: 'Odile Brannagh', kind: 'fiction', rating: 9 },
    { title: 'Brassbound #1', author: 'Rue Fenwick', kind: 'comic', rating: 9, monthsAgo: 6 },
    { title: 'Kettle City Nights', author: 'Rue Fenwick', kind: 'comic', rating: 8 },
    { title: 'The Pocket Planner', author: 'Dorit Allenby', kind: 'self_help', rating: 4 },
    {
      title: 'Ten Minute Mornings',
      author: 'Cass Wrenfield',
      kind: 'self_help',
      rating: 3,
      monthsAgo: 26,
    },
    { title: 'Habits of Tidy Minds', author: 'Ivo Pellerin', kind: 'self_help', rating: 4 },
    { title: 'Moss and Mortar', author: 'Juno Teague', kind: 'fiction' },
    {
      title: 'A Short History of Invented Hats',
      author: 'Pim Ostrava',
      kind: 'nonfiction',
      dnf: true,
    },
  ];
  const now = nowIso();
  for (const b of books) {
    const id = newId();
    db.prepare(
      `INSERT INTO items (id, title, title_source, creators, identifiers, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, '{}', ?, ?)`,
    ).run(id, b.title, JSON.stringify([{ name: b.author }]), now, now);
    db.prepare(
      `INSERT INTO locations (id, item_id, kind, note, created_at, updated_at)
       VALUES (?, ?, 'history', 'Read elsewhere (demo)', ?, ?)`,
    ).run(newId(), id, now, now);
    applyUserPatch(db, id, {
      kindOverride: b.kind,
      ...(b.dnf
        ? { progress: 'dnf', dnfReason: 'not_for_me' }
        : b.monthsAgo !== undefined
          ? {
              progress: 'finished',
              finishedOn: monthsAgo(b.monthsAgo),
              finishedPrecision: 'approximate',
              rating: b.rating ?? null,
            }
          : { progress: 'finished', finishedPrecision: 'unknown', rating: b.rating ?? null }),
    });
  }
}
