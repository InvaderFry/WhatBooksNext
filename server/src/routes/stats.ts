import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import { exportCsv } from '../lib/export.ts';
import { listFullSnapshots, takeFullSnapshot } from '../lib/fullSnapshot.ts';
import type { FolderReachability } from '../lib/library.ts';
import { matchReport } from '../lib/matchReport.ts';
import { loadRankData } from '../lib/rankData.ts';
import { computeStats } from '../lib/stats.ts';
import { tasteSummary } from '../lib/taste.ts';
import { loadStrength, tasteFrom } from '../lib/tune.ts';
import type { ScanManager } from '../scan/scanManager.ts';
import type { Sources } from '../sources/index.ts';
import { HttpError, todayLocal } from '../util.ts';
import { route } from './route.ts';

/** Milestone 6: Stats (§15), the CSV export and full local snapshots (§16). */

export interface StatsDeps {
  db: DB;
  sources: Sources;
  scans: ScanManager;
  dataDir: string | null;
  reach: () => Promise<FolderReachability>;
}

export function registerStatsRoutes(app: Express, d: StatsDeps): void {
  const { db } = d;

  app.get(
    '/api/stats',
    route(async () => {
      const data = loadRankData(db, await d.reach());
      const folderNames = new Map(
        (
          db.prepare('SELECT id, display_path FROM folders').all() as {
            id: string;
            display_path: string;
          }[]
        ).map((f) => [f.id, f.display_path]),
      );
      const folders = new Map([...data.library.values()].map((i) => [i.id, i.folderIds]));
      const report = matchReport(db, (kind, issue) => d.sources.forItem(kind, issue).length > 0);
      return {
        ...computeStats({ items: data.items, folders, folderNames, today: todayLocal() }),
        taste: tasteSummary(tasteFrom(data.items, loadStrength(db))),
        matches: { byBand: report.byBand, labelled: report.labelled },
      };
    }),
  );

  app.get(
    '/api/export/csv',
    route(async (_req, res) => {
      const data = loadRankData(db, await d.reach());
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="whatbooksnext-library-${todayLocal()}.csv"`,
      );
      res.send(exportCsv(db, data.items));
    }),
  );

  app.get(
    '/api/snapshots/full',
    route(() => ({
      available: d.dataDir !== null,
      snapshots: d.dataDir ? listFullSnapshots(d.dataDir) : [],
    })),
  );

  app.post(
    '/api/snapshots/full',
    route(async () => {
      if (!d.dataDir) throw new HttpError(400, 'This app has no data folder to save into.');
      // A scan writes covers and rows as it goes; a snapshot taken then could hold half of it.
      // (Lookups may run on: SQLite's backup API copies a consistent database regardless.)
      if (d.scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      return { snapshot: await takeFullSnapshot(db, d.dataDir) };
    }),
  );
}
