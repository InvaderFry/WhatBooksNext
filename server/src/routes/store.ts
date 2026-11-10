import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import { applyIdentity, matchFactsFor, storeCandidates } from '../identify/lookups.ts';
import { scoreCandidate } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import {
  addLocation,
  createStoreItem,
  importCsv,
  previewCsv,
  STORES,
  validateFields,
  type Store,
} from '../lib/store.ts';
import type { Sources } from '../sources/index.ts';
import { SOURCE_LABELS, SourceError, type SourceRecord } from '../sources/types.ts';
import { HttpError, newId, nowIso } from '../util.ts';
import { route } from './route.ts';

/** Store titles and the store CSV import (§14). */

/** The last few store searches, so a pick refers to a record the server itself fetched. */
const searches = new Map<string, SourceRecord[]>();

export function registerStoreRoutes(
  app: Express,
  d: { db: DB; sources: Sources; itemIdOr404: (raw: string) => string },
): void {
  const { db, sources } = d;
  const store = (v: unknown): Store => {
    if (typeof v !== 'string' || !(STORES as readonly string[]).includes(v))
      throw new HttpError(400, `store must be one of ${STORES.join(', ')}.`);
    return v as Store;
  };

  // Add by search: the configured sources, like Needs review's Search and pick.
  app.post(
    '/api/store/search',
    route(async (req) => {
      const q = String(req.body?.query ?? '').trim();
      if (q.length < 2) throw new HttpError(400, 'Type at least two letters.');
      if (q.length > 200) throw new HttpError(400, 'That search is too long.');
      const author =
        typeof req.body?.author === 'string' ? req.body.author.trim().slice(0, 100) : '';
      const records: SourceRecord[] = [];
      const errors: string[] = [];
      for (const s of sources.forSearch(null)) {
        try {
          records.push(...(await s.search({ title: q, author: author || undefined })));
        } catch (e) {
          errors.push(
            e instanceof SourceError
              ? `${SOURCE_LABELS[e.source]}: ${e.message}`
              : (e as Error).message,
          );
        }
      }
      const token = newId();
      searches.set(token, records.slice(0, 30));
      if (searches.size > 20) searches.delete(searches.keys().next().value!);
      return {
        token,
        errors,
        results: records.slice(0, 30).map((r, index) => ({
          index,
          source: SOURCE_LABELS[r.source],
          title: r.subtitle ? `${r.title}: ${r.subtitle}` : r.title,
          authors: r.authors,
          year: r.firstPublishYear ?? null,
        })),
      };
    }),
  );

  /**
   * Adds a store book: typed in, or picked from a search. A pick that is already a book's
   * confirmed (or certain) match joins that book instead of making a second one (§14).
   */
  app.post(
    '/api/store/items',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const s = store(b.store);
      const readable = b.readable === true;
      const pick = b.pick as { token?: unknown; index?: unknown } | undefined;
      return db.transaction(() => {
        if (pick) {
          const rec = searches.get(String(pick.token))?.[Number(pick.index)];
          if (!rec) throw new HttpError(409, 'Search again, then pick.');
          const key = `${rec.source}:${rec.sourceId}`;
          const existing = db
            .prepare(
              `SELECT i.id FROM items i LEFT JOIN user_item u ON u.item_id = i.id
               WHERE u.match_override = ? OR (i.identity = 'accepted' AND i.match_source = ? AND i.match_source_id = ?)`,
            )
            .pluck()
            .get(key, rec.source, rec.sourceId) as string | undefined;
          if (existing) {
            addLocation(db, existing, s, readable);
            return { itemId: existing, joined: true };
          }
          const itemId = createStoreItem(db, {
            title: rec.title,
            author: rec.authors[0] ?? null,
            isbn: rec.isbns.find((x) => x.length === 13) ?? rec.isbns[0] ?? null,
            series: rec.series?.name ?? null,
            number: rec.series?.position !== undefined ? String(rec.series.position) : null,
            store: s,
            readable,
          });
          storeCandidates(
            db,
            itemId,
            rec.source,
            [],
            scoreCandidate(matchFactsFor(db, itemId)!, rec),
          );
          db.prepare(
            'UPDATE user_item SET match_override = ?, updated_at = ? WHERE item_id = ?',
          ).run(key, nowIso(), itemId);
          applyIdentity(db, itemId);
          syncSeries(db);
          return { itemId, joined: false };
        }
        const f = validateFields({ ...b, store: s, readable });
        const itemId = createStoreItem(db, f);
        syncSeries(db);
        return { itemId, joined: false };
      })();
    }),
  );

  // ---- Places to read an item (§7 locations, §13.1) -----------------------------------------
  app.get(
    '/api/items/:id/locations',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      return db
        .prepare(
          `SELECT id, kind, store, confirmed_readable AS readable, note FROM locations
           WHERE item_id = ? ORDER BY kind, store`,
        )
        .all(id)
        .map((r) => ({ ...(r as object), readable: (r as { readable: number }).readable === 1 }));
    }),
  );
  app.post(
    '/api/items/:id/locations',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      return { id: addLocation(db, id, store(req.body?.store), req.body?.readable === true) };
    }),
  );
  app.patch(
    '/api/locations/:id',
    route((req) => {
      if (typeof req.body?.readable !== 'boolean')
        throw new HttpError(400, 'readable must be true or false.');
      const r = db
        .prepare(
          "UPDATE locations SET confirmed_readable = ?, updated_at = ? WHERE id = ? AND kind = 'store'",
        )
        .run(req.body.readable ? 1 : 0, nowIso(), String(req.params.id));
      if (r.changes === 0) throw new HttpError(404, 'No such place.');
      return { ok: true };
    }),
  );
  app.delete(
    '/api/locations/:id',
    route((req) => {
      const r = db
        .prepare("DELETE FROM locations WHERE id = ? AND kind = 'store'")
        .run(String(req.params.id));
      if (r.changes === 0) throw new HttpError(404, 'No such place.');
      return { ok: true };
    }),
  );

  // ---- Store CSV (§14): preview first, then import; repeatable --------------------------------
  const csvText = (b: unknown) => {
    const t = (b as { text?: unknown } | null)?.text;
    if (typeof t !== 'string' || !t.trim()) throw new HttpError(400, 'Choose a CSV file.');
    if (t.length > 20_000_000) throw new HttpError(400, 'That file is too large.');
    return t;
  };
  app.post(
    '/api/import/csv/preview',
    route((req) => previewCsv(db, csvText(req.body))),
  );
  app.post(
    '/api/import/csv',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const attach = Array.isArray(b.attach)
        ? b.attach.filter((x): x is number => Number.isInteger(x))
        : [];
      return importCsv(db, csvText(b), { attach, keepNew: b.keepNew !== false });
    }),
  );
}
