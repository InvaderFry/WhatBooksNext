import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import type { FolderReachability } from '../lib/library.ts';
import {
  markReadElsewhere,
  removeHistoryEntry,
  seriesView,
  setSeriesStatus,
} from '../lib/seriesView.ts';
import { HttpError } from '../util.ts';
import { route } from './route.ts';

/**
 * Milestone 4 series routes (§12.5, §13.4): a series with its order and gaps, the owner's
 * "finished / ongoing" correction, and marking gaps read elsewhere. GETs change nothing (§6.3).
 */

export interface SeriesDeps {
  db: DB;
  reach: () => Promise<FolderReachability>;
  itemIdOr404: (raw: string) => string;
}

export function registerSeriesRoutes(app: Express, d: SeriesDeps): void {
  const { db } = d;

  app.get(
    '/api/series/:id',
    route(async (req) => seriesView(db, await d.reach(), String(req.params.id))),
  );

  app.put(
    '/api/series/:id',
    route((req) => {
      const status = (req.body ?? {}).status as unknown;
      if (status !== null && status !== 'finished' && status !== 'ongoing')
        throw new HttpError(400, 'status must be finished, ongoing or null.');
      setSeriesStatus(db, String(req.params.id), status);
      return { ok: true };
    }),
  );

  app.post(
    '/api/series/:id/read-elsewhere',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const made = markReadElsewhere(
        db,
        String(req.params.id),
        b.unit as 'volume' | 'issue',
        Number(b.from),
        Number(b.to ?? b.from),
      );
      return { ok: true, itemIds: made };
    }),
  );

  // Removes an entry that only records reading elsewhere (never a book with files or a store copy).
  app.delete(
    '/api/items/:id',
    route((req) => {
      removeHistoryEntry(db, d.itemIdOr404(String(req.params.id)));
      return { ok: true };
    }),
  );
}
