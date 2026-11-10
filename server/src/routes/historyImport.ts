import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import { importHistory, previewHistory, type HistorySource } from '../lib/historyImport.ts';
import { HttpError } from '../util.ts';
import { route } from './route.ts';

export function registerHistoryImportRoutes(app: Express, db: DB): void {
  const input = (body: Record<string, unknown>) => {
    if (body.source !== 'goodreads' && body.source !== 'storygraph')
      throw new HttpError(400, 'Choose Goodreads or StoryGraph.');
    if (typeof body.text !== 'string' || !body.text.trim())
      throw new HttpError(400, 'Choose a history CSV file.');
    if (body.text.length > 20_000_000) throw new HttpError(400, 'That file is too large.');
    return { text: body.text, source: body.source as HistorySource };
  };
  app.post(
    '/api/import/history/preview',
    route((req) => {
      const { text, source } = input(req.body ?? {});
      return previewHistory(db, text, source);
    }),
  );
  app.post(
    '/api/import/history',
    route((req) => {
      const b = req.body ?? {};
      const { text, source } = input(b);
      return importHistory(db, text, source, {
        attach: Array.isArray(b.attach) ? b.attach.filter((v: unknown) => Number.isInteger(v)) : [],
        keepUnmatched: b.keepUnmatched !== false,
      });
    }),
  );
}
