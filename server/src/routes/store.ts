import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { DB } from '../db/database.ts';
import { applyIdentity, matchFactsFor, storeCandidates } from '../identify/lookups.ts';
import { scoreCandidate } from '../identify/match.ts';
import { syncSeries } from '../identify/series.ts';
import {
  addLocation,
  checkStoreLink,
  createStoreItem,
  importCsv,
  previewCsv,
  setLocationLink,
  STORES,
  validateFields,
  type Store,
} from '../lib/store.ts';
import {
  actOnNotSeen,
  COLLECTORS,
  importPurchases,
  previewPurchases,
  SERVICES,
} from '../lib/storePurchases.ts';
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
      // A link the owner typed or pasted is theirs: imports never replace it.
      const link = typeof b.url === 'string' && b.url.trim() ? checkStoreLink(s, b.url) : null;
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
            addLocation(db, existing, s, readable, link, true);
            return { itemId: existing, joined: true };
          }
          const itemId = createStoreItem(
            db,
            {
              title: rec.title,
              author: rec.authors[0] ?? null,
              isbn: rec.isbns.find((x) => x.length === 13) ?? rec.isbns[0] ?? null,
              series: rec.series?.name ?? null,
              number: rec.series?.position !== undefined ? String(rec.series.position) : null,
              store: s,
              readable,
              link,
            },
            true,
          );
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
        const itemId = createStoreItem(db, f, true);
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
      return (
        db
          .prepare(
            `SELECT id, kind, store, confirmed_readable, note, url, url_kind, url_by_owner
             FROM locations WHERE item_id = ? ORDER BY kind, store`,
          )
          .all(id) as {
          id: string;
          kind: string;
          store: string | null;
          confirmed_readable: number;
          note: string | null;
          url: string | null;
          url_kind: string | null;
          url_by_owner: number;
        }[]
      ).map((r) => ({
        id: r.id,
        kind: r.kind,
        store: r.store,
        readable: r.confirmed_readable === 1,
        note: r.note,
        url: r.url,
        urlKind: r.url_kind,
        /** Shown next to an "another app" link, so the owner can see where it goes. */
        urlHost: r.url ? new URL(r.url).hostname : null,
        urlByOwner: r.url_by_owner === 1,
      }));
    }),
  );
  app.post(
    '/api/items/:id/locations',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const s = store(req.body?.store);
      const url = req.body?.url;
      const link = typeof url === 'string' && url.trim() ? checkStoreLink(s, url) : null;
      return { id: addLocation(db, id, s, req.body?.readable === true, link, true) };
    }),
  );
  /**
   * Changes a store copy: "I can read it there now", and its link. A link set here is the
   * owner's (Add / Change link); `url: null` removes it, and a removed link stays removed.
   */
  app.patch(
    '/api/locations/:id',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const hasReadable = 'readable' in b;
      const hasUrl = 'url' in b;
      if (!hasReadable && !hasUrl) throw new HttpError(400, 'Nothing to change.');
      if (hasReadable && typeof b.readable !== 'boolean')
        throw new HttpError(400, 'readable must be true or false.');
      if (hasUrl && b.url !== null && typeof b.url !== 'string')
        throw new HttpError(400, 'url must be a link or null.');
      const id = String(req.params.id);
      const loc = db
        .prepare("SELECT store FROM locations WHERE id = ? AND kind = 'store'")
        .get(id) as { store: Store | null } | undefined;
      if (!loc) throw new HttpError(404, 'No such place.');
      const link =
        typeof b.url === 'string' && b.url.trim()
          ? checkStoreLink(loc.store ?? 'other', b.url)
          : null;
      db.transaction(() => {
        if (hasReadable)
          db.prepare(
            'UPDATE locations SET confirmed_readable = ?, updated_at = ? WHERE id = ?',
          ).run(b.readable ? 1 : 0, nowIso(), id);
        if (hasUrl) setLocationLink(db, id, link, true);
      })();
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

  // ---- Store purchases (store purchases plan, "1b"): a collector's file, preview then import --
  const fileText = (b: unknown) => {
    const t = (b as { text?: unknown } | null)?.text;
    if (typeof t !== 'string' || !t.trim()) throw new HttpError(400, 'Choose the store file.');
    if (t.length > 50_000_000) throw new HttpError(400, 'That file is too large.');
    return t;
  };
  const accountName = (b: Record<string, unknown>) =>
    typeof b.accountName === 'string' ? b.accountName.slice(0, 40) : null;
  const keys = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100_000) : [];
  app.post(
    '/api/import/store-purchases/preview',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return previewPurchases(db, fileText(b), { accountName: accountName(b) });
    }),
  );
  app.post(
    '/api/import/store-purchases',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return importPurchases(db, fileText(b), {
        attach: keys(b.attach),
        uncertain: keys(b.uncertain),
        keepNew: b.keepNew !== false,
        accountName: accountName(b),
        confirmShrink: b.confirmShrink === true,
      });
    }),
  );
  app.post(
    '/api/store-purchases/:id/not-seen',
    route((req) => {
      const action = req.body?.action;
      if (action !== 'keep' && action !== 'remove')
        throw new HttpError(400, 'action must be keep or remove.');
      actOnNotSeen(db, String(req.params.id), action);
      syncSeries(db);
      return { ok: true };
    }),
  );

  /**
   * Each store's collector: whether it's built and checked, and the console script to copy. The
   * script is the committed build in tools/store-collector/console-scripts (no build needed).
   */
  const SCRIPTS = path.join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'tools',
    'store-collector',
    'console-scripts',
  );
  app.get(
    '/api/store-collectors',
    route(() => SERVICES.map((s) => ({ service: s, ...COLLECTORS[s] }))),
  );
  app.get(
    '/api/store-collectors/:service/script',
    route((req) => {
      const s = String(req.params.service);
      const c = (COLLECTORS as Record<string, (typeof COLLECTORS)[keyof typeof COLLECTORS]>)[s];
      if (!c || c.state === 'not_built')
        throw new HttpError(404, 'There’s no collector for that store yet.');
      return { script: fs.readFileSync(path.join(SCRIPTS, `${s}.js`), 'utf8') };
    }),
  );
}
