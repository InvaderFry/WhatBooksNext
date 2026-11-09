import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_JSON_BODY, SCAN_REMINDER_DAYS } from './config.ts';
import { schemaVersion, type DB } from './db/database.ts';
import { listSnapshots } from './db/snapshots.ts';
import { removeOrphanItems } from './identify/items.ts';
import { createBackup, previewRestore, restoreBackup, validateBackup } from './lib/backup.ts';
import {
  itemParse,
  loadLibrary,
  queryLibrary,
  resolveItemId,
  type FolderReachability,
  type LibraryQuery,
} from './lib/library.ts';
import {
  applyUserPatch,
  shortlistAdd,
  shortlistMove,
  shortlistRemove,
  validatePatch,
} from './lib/progress.ts';
import { availabilityFromAttributes, type Platform } from './platform/types.ts';
import {
  addFolder,
  joinRel,
  reconnectFolder,
  resolveFolderRoot,
  type FolderRow,
} from './scan/folders.ts';
import { ScanManager } from './scan/scanManager.ts';
import { requestGuard, securityHeaders } from './security.ts';
import { HttpError, nowIso, todayLocal } from './util.ts';

export interface AppContext {
  db: DB;
  platform: Platform;
  port: number;
  /** Vite's dev server port, allowed as Host/Origin in development only (§6.3). */
  devPorts?: number[];
  dataDir: string | null;
  snapshotDir: string | null;
  /** Built web UI to serve, if present. */
  webDist?: string | null;
  demo?: boolean;
}

/** Folder reachability, refreshed at most every few seconds (a check asks the platform). */
class Reachability {
  private cache: FolderReachability = new Map();
  private checkedAt = 0;
  private readonly ctx: AppContext;
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  async get(force = false): Promise<FolderReachability> {
    if (!force && Date.now() - this.checkedAt < 5000) return this.cache;
    const folders = this.ctx.db.prepare('SELECT * FROM folders').all() as FolderRow[];
    const next: FolderReachability = new Map();
    for (const f of folders)
      next.set(f.id, (await resolveFolderRoot(this.ctx.db, this.ctx.platform, f)) !== null);
    this.cache = next;
    this.checkedAt = Date.now();
    return next;
  }
  invalidate() {
    this.checkedAt = 0;
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).then((body) => {
      if (!res.headersSent) res.json(body ?? { ok: true });
    }, next);
  };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (v === '1' || v === 'true' ? true : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;

export function createApp(ctx: AppContext) {
  const { db, platform } = ctx;
  const scans = new ScanManager(db, platform);
  const reach = new Reachability(ctx);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(securityHeaders);
  app.use(requestGuard({ port: ctx.port, devPorts: ctx.devPorts }));
  app.use(express.json({ limit: MAX_JSON_BODY }));

  const itemIdOr404 = (raw: string): string => {
    const id = resolveItemId(db, raw);
    if (!id) throw new HttpError(404, 'No such item.');
    return id;
  };

  // ---- App state -----------------------------------------------------------------------------
  app.get(
    '/api/state',
    route(() => ({
      demo: Boolean(ctx.demo),
      platform: platform.name,
      folders: db.prepare('SELECT COUNT(*) FROM folders').pluck().get(),
      items: db.prepare('SELECT COUNT(*) FROM items').pluck().get(),
      scanRunning: scans.isRunning(),
    })),
  );

  // ---- Folders ---------------------------------------------------------------------------------
  app.get(
    '/api/folders',
    route(async () => {
      const r = await reach.get(true);
      const folders = db
        .prepare('SELECT * FROM folders ORDER BY display_path')
        .all() as FolderRow[];
      const counts = db
        .prepare(
          `SELECT folder_id, availability, COUNT(*) AS n, SUM(stale) AS stale FROM files GROUP BY folder_id, availability`,
        )
        .all() as { folder_id: string; availability: string; n: number; stale: number }[];
      const reminderBefore = Date.now() - SCAN_REMINDER_DAYS * 86_400_000;
      return folders.map((f) => ({
        id: f.id,
        displayPath: f.display_path,
        volumeLabel: f.volume_label,
        lastLetter: f.last_letter,
        storageKind: f.storage_kind,
        alsoInICloud: f.also_in_icloud === 1,
        reachable: r.get(f.id) ?? false,
        lastSeenAt: f.last_seen_at,
        lastCompleteScanAt: f.last_complete_scan_at,
        scanOverdue:
          !f.last_complete_scan_at || Date.parse(f.last_complete_scan_at) < reminderBefore,
        files: Object.fromEntries(
          counts.filter((c) => c.folder_id === f.id).map((c) => [c.availability, c.n]),
        ),
        staleFiles: counts
          .filter((c) => c.folder_id === f.id)
          .reduce((a, c) => a + (c.stale ?? 0), 0),
      }));
    }),
  );

  app.post(
    '/api/folders',
    route(async (req) => {
      if (scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      const f = await addFolder(db, platform, {
        path: String(req.body?.path ?? ''),
        dataDir: ctx.dataDir ?? undefined,
      });
      reach.invalidate();
      return { id: f.id };
    }),
  );

  app.patch(
    '/api/folders/:id',
    route((req) => {
      const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id) as
        FolderRow | undefined;
      if (!f) throw new HttpError(404, 'No such folder.');
      const body = req.body as Record<string, unknown>;
      for (const k of Object.keys(body))
        if (k !== 'alsoInICloud') throw new HttpError(400, `Unknown field "${k}".`);
      if (typeof body.alsoInICloud !== 'boolean')
        throw new HttpError(400, 'alsoInICloud must be true or false.');
      db.prepare('UPDATE folders SET also_in_icloud = ?, updated_at = ? WHERE id = ?').run(
        body.alsoInICloud ? 1 : 0,
        nowIso(),
        f.id,
      );
      return { ok: true };
    }),
  );

  app.post(
    '/api/folders/:id/reconnect',
    route(async (req) => {
      if (scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      await reconnectFolder(db, platform, String(req.params.id), String(req.body?.path ?? ''));
      reach.invalidate();
      return { ok: true };
    }),
  );

  app.delete(
    '/api/folders/:id',
    route((req) => {
      if (scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      const removed = db.transaction(() => {
        const r = db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
        if (r.changes === 0) throw new HttpError(404, 'No such folder.');
        db.prepare(
          'INSERT OR REPLACE INTO deletions (entity, entity_id, deleted_at) VALUES (?, ?, ?)',
        ).run('folder', req.params.id, nowIso());
        // Items whose only files were here go too — unless the owner recorded anything on them.
        return removeOrphanItems(db);
      })();
      reach.invalidate();
      return { ok: true, itemsRemoved: removed };
    }),
  );

  // ---- Scanning --------------------------------------------------------------------------------
  app.get(
    '/api/scan',
    route(() => ({ status: scans.status() })),
  );
  app.post(
    '/api/scan',
    route((req) => {
      const ids = Array.isArray(req.body?.folderIds) ? (req.body.folderIds as string[]) : undefined;
      reach.invalidate();
      return { status: scans.start(ids) };
    }),
  );
  app.post(
    '/api/scan/cancel',
    route(() => ({ cancelled: scans.requestCancel() })),
  );

  // ---- Library ---------------------------------------------------------------------------------
  app.get(
    '/api/items',
    route(async (req) => {
      const q: LibraryQuery = {
        q: str(req.query.q),
        kind: str(req.query.kind),
        progress: str(req.query.progress),
        format: str(req.query.format),
        availability: str(req.query.availability),
        folder: str(req.query.folder),
        shortlisted: bool(req.query.shortlisted),
        readyToRead: bool(req.query.ready),
        showHidden: bool(req.query.hidden),
        sort: str(req.query.sort),
        dir: req.query.dir === 'desc' ? 'desc' : 'asc',
        offset: int(req.query.offset),
        limit: int(req.query.limit),
      };
      const { items } = loadLibrary(db, await reach.get());
      return queryLibrary(items, q);
    }),
  );

  app.get(
    '/api/items/:id',
    route(async (req) => {
      const id = itemIdOr404(String(req.params.id));
      const lib = loadLibrary(db, await reach.get(), [id]);
      const item = lib.items[0]!;
      const files = db
        .prepare(
          `SELECT f.*, x.is_primary FROM files f JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ?
           ORDER BY x.is_primary DESC, f.rel_path`,
        )
        .all(id) as (Record<string, unknown> & { folder_id: string })[];
      const r = await reach.get();
      return {
        ...item,
        redirectedFrom: id !== req.params.id ? req.params.id : undefined,
        parse: itemParse(db, id),
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          relPath: f.rel_path,
          folderId: f.folder_id,
          folderPath: lib.folders.get(f.folder_id)?.display_path ?? '',
          folderReachable: r.get(f.folder_id) ?? false,
          format: f.format,
          size: f.size,
          availability: f.availability,
          stale: f.stale === 1,
          isPrimary: f.is_primary === 1,
          qualityTag: f.quality_tag,
          editionNumber: f.edition_number,
          editionNote: f.edition_note,
          language: f.language,
          modifiedMs: f.modified_ms,
          firstSeenAt: f.first_seen_at,
        })),
      };
    }),
  );

  app.patch(
    '/api/items/:id',
    route((req) => {
      const id = itemIdOr404(String(req.params.id));
      const patch = validatePatch(req.body);
      db.transaction(() => applyUserPatch(db, id, patch, todayLocal()))();
      return { ok: true };
    }),
  );

  // ---- Shortlist -------------------------------------------------------------------------------
  app.get(
    '/api/shortlist',
    route(async () => {
      const { items } = loadLibrary(db, await reach.get());
      return items
        .filter((i) => i.user.shortlistPosition !== null)
        .sort((a, b) => a.user.shortlistPosition! - b.user.shortlistPosition!);
    }),
  );
  app.post(
    '/api/shortlist',
    route((req) => {
      const id = itemIdOr404(String(req.body?.itemId ?? ''));
      db.transaction(() => shortlistAdd(db, id))();
      return { ok: true };
    }),
  );
  app.post(
    '/api/shortlist/move',
    route((req) => {
      const id = itemIdOr404(String(req.body?.itemId ?? ''));
      const dir = req.body?.direction;
      if (dir !== 'up' && dir !== 'down')
        throw new HttpError(400, 'direction must be "up" or "down".');
      shortlistMove(db, id, dir);
      return { ok: true };
    }),
  );
  app.delete(
    '/api/shortlist/:itemId',
    route((req) => {
      shortlistRemove(db, itemIdOr404(String(req.params.itemId)));
      return { ok: true };
    }),
  );

  // ---- Open / Show in folder (POST only, ids only — never paths; §6.3, §14) --------------------
  const fileForAction = async (req: Request) => {
    const f = db
      .prepare('SELECT folder_id, rel_path, availability FROM files WHERE id = ?')
      .get(String(req.params.fileId)) as
      { folder_id: string; rel_path: string; availability: string } | undefined;
    if (!f) throw new HttpError(404, 'No such file.');
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(f.folder_id) as FolderRow;
    const root = await resolveFolderRoot(db, platform, folder);
    if (!root) {
      throw new HttpError(
        409,
        folder.storage_kind === 'external'
          ? 'The external drive is not connected.'
          : 'That folder is not reachable.',
      );
    }
    const abs = joinRel(root, f.rel_path);
    if (!fs.existsSync(abs))
      throw new HttpError(
        409,
        'The file is no longer there. Scan the folder to update the library.',
      );
    return { abs, availability: f.availability };
  };

  app.post(
    '/api/files/:fileId/open',
    route(async (req) => {
      const { abs } = await fileForAction(req);
      // Re-check right now, not the scan's answer (§9.5).
      const state = platform.supportsPlaceholders
        ? availabilityFromAttributes(await platform.checkAttributes(abs))
        : 'present';
      if (state !== 'present' && req.body?.confirmDownload !== true) {
        throw new NeedsConfirmation(
          state === 'placeholder'
            ? 'This file is in the cloud and will download when opened. Open anyway?'
            : "This file's download state can't be checked, so opening it may download it. Open anyway?",
        );
      }
      await platform.openFile(abs);
      return { ok: true };
    }),
  );

  app.post(
    '/api/files/:fileId/show',
    route(async (req) => {
      const { abs } = await fileForAction(req);
      await platform.showInFolder(abs);
      return { ok: true };
    }),
  );

  // ---- Backup and restore (§16) ----------------------------------------------------------------
  app.get('/api/backup', (_req, res) => {
    const backup = createBackup(db);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="whatbooksnext-backup-${todayLocal()}.json"`,
    );
    res.json(backup);
  });

  app.post(
    '/api/restore/preview',
    route((req) => previewRestore(db, validateBackup(db, req.body?.backup))),
  );

  app.post(
    '/api/restore',
    route(async (req) => {
      if (scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      if (req.body?.confirm !== true)
        throw new HttpError(400, 'Restoring replaces all app data; confirm first.');
      const backup = validateBackup(db, req.body?.backup);
      try {
        const r = await restoreBackup(db, backup, ctx.snapshotDir);
        reach.invalidate();
        return { ok: true, snapshotPath: r.snapshotPath };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(
          400,
          `The backup couldn't be applied, so nothing was changed. (${(err as Error).message})`,
        );
      }
    }),
  );

  // ---- Diagnostics (§15) -----------------------------------------------------------------------
  app.get(
    '/api/diagnostics',
    route(async (req) => {
      const includeNames = bool(req.query.names) ?? false;
      const r = await reach.get(true);
      const folders = db
        .prepare('SELECT * FROM folders ORDER BY display_path')
        .all() as FolderRow[];
      const counts = db
        .prepare(
          'SELECT folder_id, availability, COUNT(*) AS n FROM files GROUP BY folder_id, availability',
        )
        .all() as { folder_id: string; availability: string; n: number }[];
      const snapshots = ctx.snapshotDir ? listSnapshots(ctx.snapshotDir) : [];
      const folderChecks = await Promise.all(
        folders.map(async (f, i) => {
          const c = Object.fromEntries(
            counts.filter((x) => x.folder_id === f.id).map((x) => [x.availability, x.n]),
          );
          // Where the volume is mounted now: just the drive letter unless names were asked for.
          let foundAt: string | null = null;
          if (f.volume_id) {
            const root = await platform.findVolumeRoot(f.volume_id);
            foundAt = root && (includeNames ? root : (/^([A-Za-z]:)/.exec(root)?.[1] ?? 'found'));
          }
          return {
            id: f.id,
            name: includeNames ? f.display_path : `Folder ${i + 1}`,
            storageKind: f.storage_kind,
            volumeLabel: includeNames ? f.volume_label : null,
            hasVolumeIdentity: Boolean(f.volume_id),
            reachable: r.get(f.id) ?? false,
            foundAt,
            lastLetter: f.last_letter,
            lastCompleteScanAt: f.last_complete_scan_at,
            files: c,
          };
        }),
      );
      return {
        app: {
          schemaVersion: schemaVersion(db),
          node: process.version,
          platform: `${process.platform} (${platform.name} adapter)`,
          demo: Boolean(ctx.demo),
        },
        lastSnapshot: snapshots[0]
          ? { kind: snapshots[0].kind, createdAt: snapshots[0].createdAt }
          : null,
        placeholderDetection: platform.supportsPlaceholders
          ? 'On: files with RecallOnDataAccess, RecallOnOpen or Offline set count as online-only.'
          : 'Not available on this platform: files count as present.',
        folders: folderChecks,
        sources: 'No online sources yet (they arrive in Milestone 3).',
      };
    }),
  );

  // ---- Web UI ----------------------------------------------------------------------------------
  if (ctx.webDist && fs.existsSync(path.join(ctx.webDist, 'index.html'))) {
    app.use(express.static(ctx.webDist, { index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(ctx.webDist!, 'index.html')));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NeedsConfirmation) {
      res.status(409).json({ error: err.message, needsConfirmation: true });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type: string }).type === 'entity.parse.failed'
    ) {
      res.status(400).json({ error: 'The request was not valid JSON.' });
      return;
    }
    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type: string }).type === 'entity.too.large'
    ) {
      res.status(413).json({ error: 'That file is too large.' });
      return;
    }
    console.error(err);
    res
      .status(500)
      .json({ error: 'Something went wrong. Details are in the window running the app.' });
  });

  return { app, scans, close: () => platform.close() };
}

/** Open on an online-only (or unknown) file asks first (§9.5). */
class NeedsConfirmation extends Error {}
