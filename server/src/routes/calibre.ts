import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import { importCalibre, previewCalibre, type CalibreOptions } from '../lib/calibre.ts';
import type { Platform } from '../platform/types.ts';
import type { ScanManager } from '../scan/scanManager.ts';
import { HttpError } from '../util.ts';
import { getSetting, setSetting } from './reading.ts';
import { route } from './route.ts';

/** Calibre import (§14): preview, then import. Read-only on Calibre: only a copy is read. */
export function registerCalibreRoutes(
  app: Express,
  d: { db: DB; platform: Platform; scans: ScanManager; dataDir: string | null },
): void {
  const { db } = d;
  const input = (b: Record<string, unknown>): { path: string; opts: CalibreOptions } => {
    if (typeof b.path !== 'string' || !b.path.trim())
      throw new HttpError(400, 'Paste the path of your Calibre library folder.');
    const col = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    return {
      path: b.path.trim().replace(/^"(.*)"$/, '$1'),
      opts: {
        ratings: b.ratings === true,
        readColumn: col(b.readColumn),
        dateColumn: col(b.dateColumn),
        keepUnmatched: b.keepUnmatched === true,
      },
    };
  };
  app.get(
    '/api/calibre',
    route(() => ({ path: getSetting<string | null>(db, 'calibrePath', null) })),
  );
  app.post(
    '/api/calibre/preview',
    route(async (req) => {
      const { path, opts } = input((req.body ?? {}) as Record<string, unknown>);
      return previewCalibre(db, d.platform, path, d.dataDir, opts);
    }),
  );
  app.post(
    '/api/calibre/import',
    route(async (req) => {
      if (d.scans.isRunning())
        throw new HttpError(409, 'Wait for the scan to finish, then try again.');
      const { path, opts } = input((req.body ?? {}) as Record<string, unknown>);
      const r = await importCalibre(db, d.platform, path, d.dataDir, opts);
      setSetting(db, 'calibrePath', path);
      return r;
    }),
  );
}
