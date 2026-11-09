import type { DB } from '../db/database.ts';
import { groupUnassignedFiles, type GroupingResult } from '../identify/grouping.ts';
import { refreshAllPrimaries } from '../identify/items.ts';
import type { Platform } from '../platform/types.ts';
import { HttpError, newId, nowIso } from '../util.ts';
import type { FolderRow } from './folders.ts';
import { lightScanFolder, type CancelToken, type FolderScanSummary } from './lightPass.ts';

export interface ScanStatus {
  runId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  folders: (FolderScanSummary & { displayPath: string })[];
  currentFolderId: string | null;
  grouping: GroupingResult | null;
  error: string | null;
}

/** One scan at a time; "Scan now" only — no scheduled scans (§4). Cancel stops after the current directory. */
export class ScanManager {
  private current: ScanStatus | null = null;
  private cancel: CancelToken | null = null;
  private running: Promise<void> | null = null;
  private readonly db: DB;
  private readonly platform: Platform;

  constructor(db: DB, platform: Platform) {
    this.db = db;
    this.platform = platform;
  }

  status(): ScanStatus | null {
    if (this.current) return this.current;
    const last = this.db
      .prepare("SELECT summary FROM scan_runs WHERE kind = 'light' ORDER BY started_at DESC LIMIT 1")
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
      error: null,
    };
    this.db
      .prepare("INSERT INTO scan_runs (id, kind, status, started_at) VALUES (?, 'light', 'running', ?)")
      .run(status.runId, status.startedAt);
    this.current = status;
    this.cancel = { cancelled: false };
    this.running = this.run(folders, status, this.cancel);
    return status;
  }

  requestCancel(): boolean {
    if (!this.isRunning() || !this.cancel) return false;
    this.cancel.cancelled = true;
    return true;
  }

  /** Resolves when the current scan (if any) has finished. */
  async wait(): Promise<ScanStatus | null> {
    await this.running;
    return this.status();
  }

  private async run(folders: FolderRow[], status: ScanStatus, cancel: CancelToken): Promise<void> {
    try {
      for (const folder of folders) {
        if (cancel.cancelled) break;
        status.currentFolderId = folder.id;
        const entry = { ...emptySummary(folder.id), displayPath: folder.display_path };
        status.folders.push(entry);
        const s = await lightScanFolder(this.db, this.platform, folder, cancel, (p) => Object.assign(entry, p));
        Object.assign(entry, s);
      }
      status.grouping = this.db.transaction(() => {
        const g = groupUnassignedFiles(this.db);
        refreshAllPrimaries(this.db);
        return g;
      })();
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
    ignoredByType: {},
  };
}
