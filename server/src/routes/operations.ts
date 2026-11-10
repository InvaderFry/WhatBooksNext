import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import {
  listOperations,
  mergeItems,
  previewMerge,
  previewSplit,
  splitItem,
  undoOperation,
  type Choice,
} from '../lib/operations.ts';
import type { ScanManager } from '../scan/scanManager.ts';
import { HttpError } from '../util.ts';
import { route } from './route.ts';

/**
 * Merge, split and undo (§11.4). Previews are POSTs only because they carry a body; they change
 * nothing. Nothing is merged or split while a scan runs: the scan is regrouping files too.
 */
export function registerOperationRoutes(
  app: Express,
  d: { db: DB; scans: ScanManager; itemIdOr404: (raw: string) => string },
): void {
  const { db } = d;
  const notScanning = () => {
    if (d.scans.isRunning())
      throw new HttpError(409, 'Wait for the scan to finish, then try again.');
  };
  const body = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, unknown>;
  const ids = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];

  app.post(
    '/api/merge/preview',
    route((req) => {
      const b = body(req);
      return previewMerge(
        db,
        d.itemIdOr404(String(b.keepId ?? '')),
        d.itemIdOr404(String(b.otherId ?? '')),
      );
    }),
  );
  app.post(
    '/api/merge',
    route((req) => {
      notScanning();
      const b = body(req);
      const choices =
        b.choices && typeof b.choices === 'object' ? (b.choices as Record<string, Choice>) : {};
      return mergeItems(
        db,
        d.itemIdOr404(String(b.keepId ?? '')),
        d.itemIdOr404(String(b.otherId ?? '')),
        choices,
      );
    }),
  );
  app.post(
    '/api/split/preview',
    route((req) => {
      const b = body(req);
      return previewSplit(db, d.itemIdOr404(String(b.itemId ?? '')), ids(b.fileIds));
    }),
  );
  app.post(
    '/api/split',
    route((req) => {
      notScanning();
      const b = body(req);
      return splitItem(
        db,
        d.itemIdOr404(String(b.itemId ?? '')),
        ids(b.fileIds),
        b.ownerData as 'stay' | 'move',
      );
    }),
  );
  app.get(
    '/api/operations',
    route(() => listOperations(db)),
  );
  app.post(
    '/api/operations/:id/undo',
    route((req) => {
      notScanning();
      undoOperation(db, String(req.params.id));
      return { ok: true };
    }),
  );
}
