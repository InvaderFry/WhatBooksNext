import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import type { FolderReachability } from '../lib/library.ts';
import { markReadElsewhere, seriesView, setSeriesStatus } from '../lib/seriesView.ts';
import { actOnCoverage, addCoverage } from '../lib/coverage.ts';
import { removeFilelessItem } from '../lib/store.ts';
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

  // ---- What a collected edition holds (§12.5) ---------------------------------------------
  app.get(
    '/api/items/:id/coverage',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      return {
        rows: db
          .prepare(
            `SELECT c.id, c.series_id AS seriesId, s.name AS seriesName, c.first_num AS first,
               c.last_num AS last, c.state, c.source
             FROM collection_coverage c JOIN series s ON s.id = c.series_id
             WHERE c.item_id = ? AND c.state != 'rejected' ORDER BY s.name, c.first_num`,
          )
          .all(id),
        // Series the owner can pick from: comics and manga.
        series: db
          .prepare(
            "SELECT id, name FROM series WHERE match_key LIKE 'c:%' ORDER BY name COLLATE NOCASE",
          )
          .all(),
      };
    }),
  );
  app.post(
    '/api/items/:id/coverage',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.seriesId !== 'string') throw new HttpError(400, 'Choose a series.');
      return { ok: true, id: addCoverage(db, id, b.seriesId, b.first, b.last) };
    }),
  );
  app.post(
    '/api/coverage/:id',
    route((req) => {
      const action = (req.body ?? {}).action as unknown;
      if (action !== 'confirm' && action !== 'reject' && action !== 'remove')
        throw new HttpError(400, 'action must be confirm, reject or remove.');
      actOnCoverage(db, String(req.params.id), action);
      return { ok: true };
    }),
  );

  // Removes a book with no files: an entry read elsewhere, or a store title. Never one with files.
  app.delete(
    '/api/items/:id',
    route((req) => {
      removeFilelessItem(db, d.itemIdOr404(String(req.params.id)));
      return { ok: true };
    }),
  );
}
