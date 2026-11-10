import type { Express } from 'express';
import { publicationLookup, refreshPublications } from '../lib/publications.ts';
import { SourceError } from '../sources/types.ts';
import type { Sources } from '../sources/index.ts';
import type { DB } from '../db/database.ts';
import { seriesRunLabel } from '../identify/series.ts';
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
  sources: Sources;
  reach: () => Promise<FolderReachability>;
  itemIdOr404: (raw: string) => string;
}

export function registerSeriesRoutes(app: Express, d: SeriesDeps): void {
  const { db } = d;

  app.get(
    '/api/series/:id',
    route(async (req) => {
      const view = seriesView(db, await d.reach(), String(req.params.id));
      const row = db
        .prepare('SELECT match_key, source_ids FROM series WHERE id = ?')
        .get(view.id) as { match_key: string | null; source_ids: string };
      return {
        ...view,
        runLabel: seriesRunLabel(row),
        publicationLookup: publicationLookup(db, d.sources, view.id),
      };
    }),
  );

  app.post(
    '/api/series/:id/publications',
    route(async (req) => {
      const id = String(req.params.id);
      seriesView(db, await d.reach(), id);
      try {
        await refreshPublications(db, d.sources, id, true);
      } catch (err) {
        if (err instanceof SourceError)
          throw new HttpError(
            503,
            `Couldn’t check published volumes. Saved catalogue data was kept. ${err.message}`,
          );
        throw err;
      }
      return { ok: true };
    }),
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
            `SELECT c.id, c.series_id AS seriesId, s.name AS seriesName, s.match_key, s.source_ids, c.first_num AS first,
               c.last_num AS last, c.state, c.source
             FROM collection_coverage c JOIN series s ON s.id = c.series_id
             WHERE c.item_id = ? AND c.state != 'rejected' ORDER BY s.name, c.first_num`,
          )
          .all(id)
          .map((raw) => {
            const { match_key, source_ids, ...row } = raw as {
              match_key: string | null;
              source_ids: string;
              seriesName: string;
              [key: string]: unknown;
            };
            const run = seriesRunLabel({ match_key, source_ids });
            return { ...row, seriesName: run ? `${row.seriesName} (${run})` : row.seriesName };
          }),
        // Series the owner can pick from: comics and manga.
        series: db
          .prepare(
            "SELECT id, name, match_key, source_ids FROM series WHERE match_key LIKE 'c:%' ORDER BY name COLLATE NOCASE",
          )
          .all()
          .map((raw) => {
            const row = raw as {
              id: string;
              name: string;
              match_key: string | null;
              source_ids: string;
            };
            const run = seriesRunLabel(row);
            return { id: row.id, name: run ? `${row.name} (${run})` : row.name };
          }),
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
