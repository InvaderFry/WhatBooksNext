import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../db/database.ts';
import { loadLibrary } from '../lib/library.ts';
import { applyUserPatch } from '../lib/progress.ts';
import type { FakePlatform } from '../platform/fake.ts';
import { ATTR_OFFLINE, ATTR_RECALL_ON_DATA_ACCESS } from '../platform/types.ts';
import { makeCbz, makeEpub, makePdf, makeZip, textLines } from '../testing/fixtures.ts';
import { fakePlatformWithDrives, memoryDb, tempDir, writeFiles } from '../testing/helpers.ts';
import { addFolder } from './folders.ts';
import type { Task } from './formats/index.ts';
import { WorkerPool, type RunOptions, type TaskRunner } from './pool.ts';
import { ScanManager } from './scanManager.ts';

const ONLINE_ONLY = 0x20 | ATTR_RECALL_ON_DATA_ACCESS | ATTR_OFFLINE;

/** Watches every content read the deep pass makes. One worker, so the order is predictable. */
class RecordingRunner implements TaskRunner {
  readonly size = 1;
  readonly tasks: Task[] = [];
  before: ((t: Task) => void) | null = null;
  readonly inner = new WorkerPool(1);
  run(t: Task, o: RunOptions) {
    this.tasks.push(t);
    this.before?.(t);
    return this.inner.run(t, o);
  }
  abort() {
    this.inner.abort();
  }
  close() {
    return this.inner.close();
  }
  readsOf(name: string) {
    return this.tasks.filter((t) => path.basename(t.file) === name).map((t) => t.kind);
  }
}

const runner = new RecordingRunner();
afterAll(() => runner.close());

let db: DB;
let drive: string;
let cloud: string;
let covers: string;
let platform: FakePlatform;
let scans: ScanManager;

beforeEach(async () => {
  db = await memoryDb();
  drive = tempDir('wbn-drive-');
  cloud = tempDir('wbn-icloud-');
  covers = tempDir('wbn-covers-');
  platform = fakePlatformWithDrives({ drive, cloud });
  runner.tasks.length = 0;
  runner.before = null;
  scans = new ScanManager(db, platform, { runner, coversDir: covers });
});

afterEach(() => {
  for (const d of [drive, cloud, covers]) fs.rmSync(d, { recursive: true, force: true });
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
    .get(name) as string | undefined;
const item = (name: string) =>
  db.prepare('SELECT * FROM items WHERE id = ?').get(itemOf(name)) as Record<string, unknown>;
const itemCount = () => db.prepare('SELECT COUNT(*) FROM items').pluck().get() as number;
const openReviews = () =>
  db.prepare("SELECT kind, tier, detail FROM review_items WHERE status = 'open'").all() as {
    kind: string;
    tier: number;
    detail: string;
  }[];
const placeholder = (root: string, rel: string) =>
  platform.attributes.set(path.join(root, ...rel.split('/')), ONLINE_ONLY);

describe('deep pass', () => {
  it('reads metadata, counts, a cover and both hashes, and the EPUB’s own title wins', async () => {
    writeFiles(drive, {
      'Novels/boatoflanterns.epub': makeEpub({
        title: 'The Boat of Lanterns',
        creators: ['Ada Quill'],
        language: 'en',
        chapters: [500, 700],
        cover: true,
      }),
    });
    await addFolder(db, platform, { path: drive });
    const s = await scan();
    expect(s.status).toBe('completed');
    const f = file('boatoflanterns.epub');
    expect(f).toMatchObject({ word_count: 1200, language: 'en', has_thumbnail: 1, problem: null });
    expect(f.partial_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.full_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(covers, `${f.id}.jpg`))).toBe(true);
    expect(item('boatoflanterns.epub')).toMatchObject({
      title: 'The Boat of Lanterns',
      title_source: 'embedded',
      creators: JSON.stringify([{ name: 'Ada Quill', role: 'aut' }]),
    });
  });

  it('keeps an owner title fix when the file’s own metadata arrives', async () => {
    writeFiles(drive, { 'b.epub': makeEpub({ title: 'From The File' }) });
    await addFolder(db, platform, { path: drive });
    await scan();
    applyUserPatch(db, itemOf('b.epub')!, { titleOverride: 'My Title' });
    await scan();
    const lib = loadLibrary(db, new Map([[file('b.epub').folder_id as string, true]]));
    expect(lib.items[0]!.title).toBe('My Title');
    expect(lib.items[0]!.factTitle).toBe('From The File');
  });

  it('makes a comic PDF a comic, and records the PDF type with its evidence', async () => {
    const page = { image: (await import('../testing/fixtures.ts')).makeImage(400, 615) };
    writeFiles(drive, {
      'shadowservice_vol1_darkarts.pdf': makePdf({
        pages: [page, page, page, page],
        width: 400,
        height: 615,
      }),
      'Widget Patterns - Ada Quill.pdf': makePdf({
        pages: [1, 2, 3].map((n) => ({ text: textLines(40, n) })),
      }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(file('shadowservice_vol1_darkarts.pdf')).toMatchObject({
      pdf_type: 'comic',
      page_count: 4,
    });
    expect(item('shadowservice_vol1_darkarts.pdf')).toMatchObject({
      kind: 'comic',
      kind_source: 'pdf_type',
    });
    expect(file('Widget Patterns - Ada Quill.pdf').pdf_type).toBe('text');
    expect(item('Widget Patterns - Ada Quill.pdf').kind).toBeNull();
  });

  it('makes a ComicInfo manga a manga, titled from its series and number', async () => {
    writeFiles(drive, {
      'sa01.cbz': makeCbz({
        comicInfo: { Series: 'Starfall Academy', Number: '1', Manga: 'YesAndRightToLeft' },
      }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(item('sa01.cbz')).toMatchObject({ kind: 'manga', title: 'Starfall Academy #1' });
  });

  it('drops a .zip that is not a comic from the library and lists it as a problem', async () => {
    writeFiles(drive, {
      'Comics/installer.zip': makeZip([
        { name: 'setup.exe', data: Buffer.alloc(2000, 3) },
        { name: 'manual.pdf', data: Buffer.alloc(2000, 4) },
      ]),
      'Comics/lanternfish_issue1.zip': makeCbz({ pages: 3 }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(file('installer.zip')).toMatchObject({ excluded: 1, problem: 'not_comic' });
    expect(itemOf('installer.zip')).toBeUndefined();
    expect(itemOf('lanternfish_issue1.zip')).toBeDefined();
    expect(itemCount()).toBe(1);
  });

  it('records an unreadable file as a problem and retries it next time', async () => {
    writeFiles(drive, { 'broken.epub': 'this is not a zip' });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(file('broken.epub')).toMatchObject({ problem: 'corrupt' });
    expect(itemOf('broken.epub')).toBeDefined(); // still in the library, by its name
    runner.tasks.length = 0;
    await scan();
    expect(runner.readsOf('broken.epub')).toEqual(['meta']);
  });

  it('skips completed stages on the next scan (resume)', async () => {
    writeFiles(drive, {
      'a.epub': makeEpub({ title: 'A' }),
      'b.cbz': makeCbz(),
      'c.mobi': 5000,
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(runner.readsOf('a.epub')).toEqual(['meta', 'thumb', 'full_hash']);
    expect(runner.readsOf('c.mobi')).toEqual(['full_hash']); // light formats: hashed only
    runner.tasks.length = 0;
    await scan();
    expect(runner.tasks).toEqual([]);
  });

  it('resumes a cancelled deep pass where it stopped', async () => {
    writeFiles(
      drive,
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`b${n}.epub`, makeEpub({ title: `B${n}` })])),
    );
    await addFolder(db, platform, { path: drive });
    runner.before = (t) => {
      if (path.basename(t.file) === 'b2.epub' && t.kind === 'thumb') scans.requestCancel();
    };
    const s = await scan();
    expect(s.status).toBe('cancelled');
    const first = runner.tasks.length;
    expect(runner.readsOf('b3.epub')).toEqual([]);
    runner.before = null;
    runner.tasks.length = 0;
    await scan();
    // b1 and b2 were read; only their full hashes and the other three files remain.
    expect(runner.readsOf('b1.epub')).toEqual(['full_hash']);
    expect(runner.readsOf('b3.epub')).toEqual(['meta', 'thumb', 'full_hash']);
    expect(first).toBe(4);
  });

  it('reads a file again after it changes', async () => {
    writeFiles(drive, { 'a.epub': makeEpub({ title: 'Before' }) });
    await addFolder(db, platform, { path: drive });
    await scan();
    writeFiles(drive, { 'a.epub': makeEpub({ title: 'After', chapters: [3000] }) });
    runner.tasks.length = 0;
    await scan();
    expect(runner.readsOf('a.epub')).toEqual(['meta', 'thumb', 'full_hash']);
    expect(item('a.epub').title).toBe('After');
  });
});

describe('scenario 12: placeholder and unknown files never reach a content reader', () => {
  it('reads no online-only or unknown file', async () => {
    writeFiles(cloud, {
      'Books/online.epub': makeEpub({ title: 'Online' }),
      'Unsorted/mystery.epub': makeEpub({ title: 'Mystery' }),
      'Books/local.epub': makeEpub({ title: 'Local' }),
    });
    placeholder(cloud, 'Books/online.epub');
    platform.unreadableAttributeDirs.add(path.join(cloud, 'Unsorted'));
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(runner.readsOf('online.epub')).toEqual([]);
    expect(runner.readsOf('mystery.epub')).toEqual([]);
    expect(runner.readsOf('local.epub')).toEqual(['meta', 'thumb', 'full_hash']);
  });

  it('re-checks each file just before reading: one that went online-only after listing is never read', async () => {
    writeFiles(drive, { 'a.epub': makeEpub({ title: 'A' }), 'b.epub': makeEpub({ title: 'B' }) });
    await addFolder(db, platform, { path: drive });
    // After the listing, while a.epub is being read, b.epub is freed up to the cloud.
    runner.before = (t) => {
      if (path.basename(t.file) === 'a.epub' && t.kind === 'meta') placeholder(drive, 'b.epub');
    };
    await scan();
    expect(runner.readsOf('b.epub')).toEqual([]);
    expect(file('b.epub').availability).toBe('placeholder');
  });

  it('re-checks before the full hash: a file freed up after its metadata read is not hashed', async () => {
    writeFiles(drive, { 'a.epub': makeEpub({ title: 'A' }) });
    await addFolder(db, platform, { path: drive });
    runner.before = (t) => {
      if (t.kind === 'thumb') placeholder(drive, 'a.epub');
    };
    await scan();
    expect(runner.readsOf('a.epub')).toEqual(['meta', 'thumb']);
    expect(file('a.epub')).toMatchObject({ availability: 'placeholder', full_hash: null });
  });

  it('reads a placeholder once it has been downloaded, even with the same size and date', async () => {
    writeFiles(cloud, { 'Books/later.epub': makeEpub({ title: 'Later' }) });
    placeholder(cloud, 'Books/later.epub');
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(runner.readsOf('later.epub')).toEqual([]);
    platform.attributes.delete(path.join(cloud, 'Books', 'later.epub'));
    await scan();
    expect(runner.readsOf('later.epub')).toEqual(['meta', 'thumb', 'full_hash']);
  });
});

describe('grouping with what the deep pass learns (§11.3)', () => {
  it('scenario 17: a Humble-style EPUB + PDF + MOBI trio groups, with nothing in Needs review', async () => {
    writeFiles(drive, {
      'Humble/glassharbor.epub': makeEpub({ title: 'Glass Harbor', language: 'en' }),
      'Humble/glassharbor.pdf': makePdf({ pages: [{ text: textLines() }] }),
      'Humble/glassharbor.mobi': 4000,
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
    expect(openReviews()).toEqual([]);
  });

  it('scenario 15: two languages of one book are split apart when nobody has used the item yet', async () => {
    writeFiles(drive, {
      'lanterns.epub': makeEpub({ title: 'Lanterns', language: 'en' }),
      'lanterns_hd.epub': makeEpub({ title: 'Linternas', language: 'es', seed: 9 }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemOf('lanterns.epub')).not.toBe(itemOf('lanterns_hd.epub'));
    expect(openReviews()).toEqual([]);
  });

  it('scenario 15: with history on the item, a language conflict goes to review tier 1 and stays grouped', async () => {
    writeFiles(drive, {
      'lanterns.epub': makeEpub({ title: 'Lanterns', language: 'en' }),
      'lanterns_hd.epub': makeEpub({ title: 'Linternas', language: 'es', seed: 9 }),
    });
    await addFolder(db, platform, { path: drive });
    // Light pass only first (as in M1), then the owner records progress.
    const light = new ScanManager(db, platform, {
      runner: {
        ...runner,
        size: 1,
        run: () => Promise.reject(new Error('no reads')),
        abort() {},
        close: async () => {},
      },
    });
    light.start();
    await light.wait();
    expect(itemOf('lanterns.epub')).toBe(itemOf('lanterns_hd.epub'));
    applyUserPatch(db, itemOf('lanterns.epub')!, { progress: 'halfway' });
    await scan();
    expect(itemOf('lanterns.epub')).toBe(itemOf('lanterns_hd.epub'));
    expect(openReviews()).toEqual([
      expect.objectContaining({
        kind: 'group_conflict',
        tier: 1,
        detail: expect.stringMatching(/languages/),
      }),
    ]);
  });

  it('scenario 24: a tech book’s 2nd and 3rd editions are never merged, even with the same embedded title', async () => {
    writeFiles(drive, {
      'Tech/pythonrecipes_2ndedition.epub': makeEpub({ title: 'Python Recipes', seed: 2 }),
      'Tech/pythonrecipes_3rdedition.epub': makeEpub({ title: 'Python Recipes', seed: 3 }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
  });

  it('scenario 25: EPUB + PDF on the drive and online-only in iCloud are one item with four files', async () => {
    const epub = makeEpub({ title: 'Glass Harbor', language: 'en' });
    const pdf = makePdf({ pages: [{ text: textLines() }] });
    writeFiles(drive, { 'Novels/glassharbor.epub': epub, 'Novels/glassharbor.pdf': pdf });
    writeFiles(cloud, { 'Books/glassharbor.epub': epub, 'Books/glassharbor.pdf': pdf });
    placeholder(cloud, 'Books/glassharbor.epub');
    placeholder(cloud, 'Books/glassharbor.pdf');
    const driveFolder = await addFolder(db, platform, { path: drive });
    const cloudFolder = await addFolder(db, platform, { path: cloud });
    await scan();
    expect(itemCount()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM item_files').pluck().get()).toBe(4);
    expect(openReviews()).toEqual([]);
    const id = itemOf('glassharbor.epub')!;
    applyUserPatch(db, id, { progress: 'halfway' });
    // Open uses a downloaded copy: the primary is the present EPUB on the drive.
    const primary = db
      .prepare(
        'SELECT f.folder_id, f.format FROM item_files x JOIN files f ON f.id = x.file_id WHERE x.item_id = ? AND x.is_primary = 1',
      )
      .get(id);
    expect(primary).toEqual({ folder_id: driveFolder.id, format: 'epub' });
    // Unplugged: still there, labelled, progress intact.
    const lib = loadLibrary(
      db,
      new Map([
        [driveFolder.id, false],
        [cloudFolder.id, true],
      ]),
    );
    expect(lib.items[0]!.availability.label).toBe('In iCloud (not downloaded)');
    expect(lib.items[0]!.user.progress).toBe('halfway');
  });

  it('scenario 26: book.epub here and book.pdf there are suggested, never grouped silently', async () => {
    writeFiles(drive, { 'Novels/riverofclocks.epub': makeEpub({ title: 'River of Clocks' }) });
    writeFiles(cloud, { 'Books/riverofclocks.pdf': makePdf({ pages: [{ text: textLines() }] }) });
    await addFolder(db, platform, { path: drive });
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(itemCount()).toBe(2);
    expect(openReviews()).toEqual([expect.objectContaining({ kind: 'cross_folder', tier: 4 })]);
    await scan();
    expect(openReviews()).toHaveLength(1); // asked once, not every scan
  });

  it('scenario 26: an HD and a standard CBZ of one issue group automatically, the HD file primary', async () => {
    writeFiles(drive, {
      'Comics/lanternfish_vol1.cbz': makeCbz({ pages: 3 }),
      'Comics/lanternfish_vol1_hd.cbz': makeCbz({ pages: 3, width: 320, height: 490 }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(1);
    const primary = db
      .prepare(
        'SELECT f.name FROM item_files x JOIN files f ON f.id = x.file_id WHERE x.is_primary = 1',
      )
      .pluck()
      .get();
    expect(primary).toBe('lanternfish_vol1_hd.cbz');
    expect(openReviews()).toEqual([]);
  });

  it('scenario 27: same name and size but different contents are split when the item has no history', async () => {
    const [a, b] = sameSizePdfs();
    writeFiles(drive, { 'One/fieldnotes.pdf': a, 'Two/fieldnotes.pdf': b });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(itemCount()).toBe(2);
    // …and offered as a suggestion instead (§11.3 rule 3).
    expect(openReviews()).toEqual([expect.objectContaining({ kind: 'cross_folder', tier: 4 })]);
  });

  it('scenario 27: with history, disagreeing copies go to review tier 1 and stay grouped', async () => {
    const [a, b] = sameSizePdfs();
    writeFiles(drive, { 'One/fieldnotes.pdf': a });
    writeFiles(cloud, { 'Two/fieldnotes.pdf': b });
    placeholder(cloud, 'Two/fieldnotes.pdf'); // not readable yet: grouped by name and size
    await addFolder(db, platform, { path: drive });
    await addFolder(db, platform, { path: cloud });
    await scan();
    expect(itemCount()).toBe(1);
    applyUserPatch(db, itemOf('fieldnotes.pdf')!, { progress: 'into_it' });
    platform.attributes.clear(); // downloaded: now it gets hashed, and the hashes disagree
    await scan();
    expect(itemCount()).toBe(1);
    expect(openReviews()).toEqual([
      expect.objectContaining({
        kind: 'group_conflict',
        tier: 1,
        detail: expect.stringMatching(/contents differ/),
      }),
    ]);
  });
});

describe('moves (§9.3)', () => {
  it('keeps progress when a file moves to another folder (same name and size)', async () => {
    writeFiles(drive, { 'Inbox/mapmaking.epub': makeEpub({ title: 'Map Making' }) });
    await addFolder(db, platform, { path: drive });
    await scan();
    const id = itemOf('mapmaking.epub')!;
    applyUserPatch(db, id, { progress: 'halfway' });
    fs.mkdirSync(path.join(drive, 'Sorted'));
    fs.renameSync(
      path.join(drive, 'Inbox', 'mapmaking.epub'),
      path.join(drive, 'Sorted', 'mapmaking.epub'),
    );
    await scan();
    const present = db
      .prepare(
        "SELECT x.item_id FROM files f JOIN item_files x ON x.file_id = f.id WHERE f.availability = 'present'",
      )
      .pluck()
      .get();
    expect(present).toBe(id);
    expect(openReviews()).toEqual([]);
  });

  it('transfers history to a renamed file by size and full hash', async () => {
    writeFiles(drive, { 'mapmaking.epub': makeEpub({ title: 'Map Making' }) });
    await addFolder(db, platform, { path: drive });
    await scan();
    const id = itemOf('mapmaking.epub')!;
    applyUserPatch(db, id, { progress: 'nearly_done', rating: 8 });
    fs.renameSync(
      path.join(drive, 'mapmaking.epub'),
      path.join(drive, 'The Art of Map Making.epub'),
    );
    await scan();
    expect(itemOf('The Art of Map Making.epub')).toBe(id);
    expect(itemCount()).toBe(1);
  });

  it('scenario 11: a partial-hash match under a new name goes to review, never transfers silently', async () => {
    const head = Buffer.alloc(70_000, 7);
    const a = Buffer.concat([head, Buffer.alloc(50_000, 1), head]);
    const b = Buffer.concat([head, Buffer.alloc(50_000, 2), head]); // same start, end and size
    writeFiles(drive, { 'oldname.pdf': a });
    await addFolder(db, platform, { path: drive });
    await scan();
    const id = itemOf('oldname.pdf')!;
    applyUserPatch(db, id, { progress: 'halfway' });
    // The full hash wasn't recorded (e.g. it went missing before hashing finished).
    db.prepare('UPDATE files SET full_hash = NULL').run();
    fs.rmSync(path.join(drive, 'oldname.pdf'));
    writeFiles(drive, { 'newname.pdf': b });
    runner.before = (t) => {
      // Keep the new file unhashed too, so only the partial hashes can be compared.
      if (t.kind === 'full_hash') platform.attributes.set(t.file, ONLINE_ONLY);
    };
    await scan();
    expect(itemOf('newname.pdf')).not.toBe(id);
    expect(openReviews()).toEqual([expect.objectContaining({ kind: 'move', tier: 1 })]);
  });

  it('scenario 11: a partial-hash collision with different full hashes is not a move at all', async () => {
    const head = Buffer.alloc(70_000, 7);
    writeFiles(drive, { 'oldname.pdf': Buffer.concat([head, Buffer.alloc(50_000, 1), head]) });
    await addFolder(db, platform, { path: drive });
    await scan();
    const id = itemOf('oldname.pdf')!;
    applyUserPatch(db, id, { progress: 'halfway' });
    fs.rmSync(path.join(drive, 'oldname.pdf'));
    writeFiles(drive, { 'newname.pdf': Buffer.concat([head, Buffer.alloc(50_000, 2), head]) });
    await scan();
    expect(itemOf('newname.pdf')).not.toBe(id);
    expect(openReviews()).toEqual([]);
  });

  it('scenario 11: a similar filename alone never transfers history', async () => {
    writeFiles(drive, { 'fieldnotes.epub': makeEpub({ title: 'Field Notes', seed: 1 }) });
    await addFolder(db, platform, { path: drive });
    await scan();
    const id = itemOf('fieldnotes.epub')!;
    applyUserPatch(db, id, { progress: 'halfway' });
    fs.rmSync(path.join(drive, 'fieldnotes.epub'));
    writeFiles(drive, {
      'field-notes.epub': makeEpub({ title: 'Field Notes', seed: 2, chapters: [999] }),
    });
    await scan();
    expect(itemOf('field-notes.epub')).not.toBe(id);
  });
});

/** Two different PDFs of exactly the same size (pdf.js ignores bytes after %%EOF). */
function sameSizePdfs(): [Buffer, Buffer] {
  const a = makePdf({ pages: [{ text: textLines(30, 1) }] });
  const b = makePdf({ pages: [{ text: textLines(30, 2) }] });
  const size = Math.max(a.length, b.length);
  const pad = (x: Buffer) => Buffer.concat([x, Buffer.alloc(size - x.length, 0x0a)]);
  return [pad(a), pad(b)];
}

describe('titles from embedded metadata', () => {
  it('keeps the edition from the filename so two editions stay distinguishable', async () => {
    writeFiles(drive, {
      'thelanternkeepers_2ndedition.epub': makeEpub({ title: 'The Lantern Keepers', seed: 2 }),
      'thelanternkeepers_3rdedition.epub': makeEpub({ title: 'The Lantern Keepers', seed: 3 }),
    });
    await addFolder(db, platform, { path: drive });
    await scan();
    expect(item('thelanternkeepers_2ndedition.epub').title).toBe(
      'The Lantern Keepers (2nd edition)',
    );
    expect(item('thelanternkeepers_3rdedition.epub').title).toBe(
      'The Lantern Keepers (3rd edition)',
    );
  });
});
