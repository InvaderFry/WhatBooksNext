import type { DB } from '../db/database.ts';
import { groupUnassignedFiles, type GroupingResult } from '../identify/grouping.ts';
import { refreshAllPrimaries, refreshFactsOfItems } from '../identify/items.ts';
import { refreshDerivedFacts } from '../identify/lookups.ts';
import { reconcileIdentity, type ReconcileResult } from '../identify/reconcile.ts';
import type { Platform } from '../platform/types.ts';
import { HttpError, newId, nowIso } from '../util.ts';
import { runDeepPass, type DeepProgress } from './deepPass.ts';
import type { FolderRow } from './folders.ts';
import { lightScanFolder, type CancelToken, type FolderScanSummary } from './lightPass.ts';
import { WorkerPool, type TaskRunner } from './pool.ts';

export interface ScanStatus {
  runId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  folders: (FolderScanSummary & { displayPath: string })[];
  currentFolderId: string | null;
  grouping: GroupingResult | null;
  /** listing → reading → hashing → finishing (§9.2). */
  phase: 'listing' | 'reading' | 'hashing' | 'finishing';
  deep: DeepProgress | null;
  identity: Omit<ReconcileResult, 'touchedItems'> | null;
  error: string | null;
}

export interface ScanOptions {
  /** Content-reading pool; a WorkerPool is created on first use when not given. */
  runner?: TaskRunner;
  /** Where thumbnails go (data/covers); null for none. */
  coversDir?: string | null;
  /** Called after every scan ends (e.g. to look up new items online, M3). */
  onFinished?: (status: ScanStatus) => void;
}

/**
 * One scan at a time; "Scan now" only — no scheduled scans (§4). A scan is the light pass over
 * every folder, then the deep pass over what it found present. Cancel stops after the current
 * directory (listing) or file (reading), and aborts a running full hash (§9.6).
 */
export class ScanManager {
  private current: ScanStatus | null = null;
  private cancel: CancelToken | null = null;
  private running: Promise<void> | null = null;
  private readonly db: DB;
  private readonly platform: Platform;
  private runner: TaskRunner | null;
  private readonly ownsRunner: boolean;
  private readonly coversDir: string | null;
  private readonly onFinished: ((s: ScanStatus) => void) | null;

  constructor(db: DB, platform: Platform, opts: ScanOptions = {}) {
    this.db = db;
    this.platform = platform;
    this.runner = opts.runner ?? null;
    this.ownsRunner = !opts.runner;
    this.coversDir = opts.coversDir ?? null;
    this.onFinished = opts.onFinished ?? null;
  }

  private getRunner(): TaskRunner {
    return (this.runner ??= new WorkerPool());
  }

  async close(): Promise<void> {
    this.requestCancel();
    await this.running;
    if (this.ownsRunner) await this.runner?.close();
  }

  status(): ScanStatus | null {
    if (this.current) return this.current;
    const last = this.db
      .prepare(
        "SELECT summary FROM scan_runs WHERE kind = 'light' ORDER BY started_at DESC LIMIT 1",
      )
      .pluck()
      .get() as string | undefined;
    return last ? (JSON.parse(last) as ScanStatus) : null;
  }

  isRunning(): boolean {
    return this.current?.status === 'running';
  }

  start(folderIds?: string[]): ScanStatus {
    if (this.isRunning()) throw new HttpError(409, 'A scan is already running.');
    const all = this.db.prepare('SELECT * FROM folders ORDER BY display_path').all() as FolderRow[];
    const folders = folderIds?.length ? all.filter((f) => folderIds.includes(f.id)) : all;
    if (folders.length === 0) throw new HttpError(400, 'Add a folder first.');
    const status: ScanStatus = {
      runId: newId(),
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      folders: [],
      currentFolderId: null,
      grouping: null,
      phase: 'listing',
      deep: null,
      identity: null,
      error: null,
    };
    this.db
      .prepare(
        "INSERT INTO scan_runs (id, kind, status, started_at) VALUES (?, 'light', 'running', ?)",
      )
      .run(status.runId, status.startedAt);
    this.current = status;
    this.cancel = { cancelled: false };
    this.running = this.run(folders, status, this.cancel);
    return status;
  }

  requestCancel(): boolean {
    if (!this.isRunning() || !this.cancel) return false;
    this.cancel.cancelled = true;
    // A full hash has no time limit; stop it now rather than after a 4 GB read (§9.6).
    if (this.current?.phase === 'hashing') this.runner?.abort();
    return true;
  }

  /** Resolves when the current scan (if any) has finished. */
  async wait(): Promise<ScanStatus | null> {
    await this.running;
    return this.status();
  }

  private async run(folders: FolderRow[], status: ScanStatus, cancel: CancelToken): Promise<void> {
    const reparsed: string[] = [];
    try {
      for (const folder of folders) {
        if (cancel.cancelled) break;
        status.currentFolderId = folder.id;
        const entry = { ...emptySummary(folder.id), displayPath: folder.display_path };
        status.folders.push(entry);
        const { reparsedFileIds = [], ...s } = await lightScanFolder(
          this.db,
          this.platform,
          folder,
          cancel,
          (p) => Object.assign(entry, p),
        );
        Object.assign(entry, s);
        reparsed.push(...reparsedFileIds);
      }
      status.currentFolderId = null;
      status.grouping = this.db.transaction(() => {
        const g = groupUnassignedFiles(this.db);
        refreshAllPrimaries(this.db);
        return g;
      })();

      // The deep pass reads only folders that were reached (§9.2, §9.3).
      const reached = status.folders
        .filter((f) => f.status !== 'unreachable')
        .map((f) => f.folderId);
      let changed: string[] = [];
      if (!cancel.cancelled && reached.length > 0) {
        status.phase = 'reading';
        const deep = await runDeepPass({
          db: this.db,
          platform: this.platform,
          runner: this.getRunner(),
          coversDir: this.coversDir,
          cancel,
          folderIds: reached,
          onProgress: (p) => {
            status.deep = p;
            if (p.phase === 'hashing') status.phase = 'hashing';
          },
        });
        status.deep = deep.progress;
        changed = deep.changedFileIds;
      }

      // Identity follows what was read — even after a cancel, for the files read so far.
      status.phase = 'finishing';
      const identity = this.db.transaction(() => {
        const r = reconcileIdentity(this.db, changed);
        groupUnassignedFiles(this.db);
        // A changed primary (new rules, a file gone) brings its item's facts and cover with it.
        const newPrimary = refreshAllPrimaries(this.db);
        const itemOf = this.db.prepare('SELECT item_id FROM item_files WHERE file_id = ?').pluck();
        const items = new Set([...r.touchedItems, ...newPrimary]);
        for (const f of [...changed, ...reparsed]) {
          const i = itemOf.get(f) as string | undefined;
          if (i) items.add(i);
        }
        // New items made from filenames this scan take their facts from their files too.
        for (const i of this.db
          .prepare('SELECT id FROM items WHERE title_source IS NULL')
          .pluck()
          .all() as string[])
          items.add(i);
        refreshFactsOfItems(this.db, [...items]);
        // Facts that follow from titles and matches (kind guesses, the reference flag).
        refreshDerivedFacts(this.db, [...items]);
        return r;
      })();
      const { touchedItems: _ignored, ...summary } = identity;
      status.identity = summary;
      status.status = cancel.cancelled ? 'cancelled' : 'completed';
    } catch (err) {
      status.status = 'failed';
      status.error = (err as Error).message;
    } finally {
      status.currentFolderId = null;
      status.finishedAt = nowIso();
      this.db
        .prepare('UPDATE scan_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?')
        .run(status.status, status.finishedAt, JSON.stringify(status), status.runId);
      this.current = null;
      this.cancel = null;
    }
    try {
      this.onFinished?.(status);
    } catch (err) {
      console.error('After-scan step failed:', err);
    }
  }
}

function emptySummary(folderId: string): FolderScanSummary {
  return {
    folderId,
    status: 'completed',
    dirsListed: 0,
    dirErrors: 0,
    linksSkipped: 0,
    filesSeen: 0,
    newFiles: 0,
    missing: 0,
    stale: 0,
    returned: 0,
    reparsed: 0,
    ignoredByType: {},
  };
}
