import type { Express } from 'express';
import { REFRESH_ACTIVE_DAYS, REFRESH_OPEN_DAYS, REFRESH_SETTLED_DAYS } from '../config.ts';
import type { DB } from '../db/database.ts';
import type { LookupManager } from '../identify/lookups.ts';
import type { RefreshScheduler } from '../identify/refresher.ts';
import { HttpError } from '../util.ts';
import { route } from './route.ts';

/**
 * Automatic refresh and starting fresh (ratings plan stage 4): the Settings controls. GET
 * requests never change anything (§6.3).
 */
export function registerRefreshRoutes(
  app: Express,
  d: { db: DB; refresher: RefreshScheduler; lookups: LookupManager; snapshotDir: string | null },
): void {
  const { refresher, lookups } = d;

  app.get(
    '/api/refresh',
    route(() => ({
      ...refresher.status(),
      intervals: {
        active: REFRESH_ACTIVE_DAYS,
        open: REFRESH_OPEN_DAYS,
        settled: REFRESH_SETTLED_DAYS,
      },
    })),
  );

  app.patch(
    '/api/settings/refresh',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(b))
        if (k !== 'enabled' && k !== 'paused') throw new HttpError(400, `Unknown field "${k}".`);
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean')
        throw new HttpError(400, 'enabled must be true or false.');
      if (b.paused !== undefined && typeof b.paused !== 'boolean')
        throw new HttpError(400, 'paused must be true or false.');
      if (typeof b.enabled === 'boolean') refresher.setEnabled(b.enabled);
      if (typeof b.paused === 'boolean') refresher.setPaused(b.paused);
      return { ok: true };
    }),
  );

  // "Refresh due books now": the due books, as an ordinary lookup run with its progress banner.
  app.post(
    '/api/refresh/due',
    route(() => ({ status: refresher.refreshDueNow() })),
  );

  // "Look up all books again": what it keeps and roughly what it costs, before confirming.
  app.get(
    '/api/lookups/fresh',
    route(() => ({ estimate: refresher.freshEstimate(), snapshot: d.snapshotDir !== null })),
  );
  app.post(
    '/api/lookups/fresh',
    route(async (req) => {
      if (req.body?.confirm !== true)
        throw new HttpError(400, 'Looking up every book again needs a confirmation first.');
      if (lookups.isRunning()) throw new HttpError(409, 'Lookups are already running.');
      return refresher.startFresh(d.snapshotDir);
    }),
  );
}
