import type { Express, Request } from 'express';
import { READ_NEXT_PAGE, RECENT_DAYS, TRIAGE_SESSION } from '../config.ts';
import type { DB } from '../db/database.ts';
import { lookUpItem, matchFactsFor, type LookupManager } from '../identify/lookups.ts';
import { buildQuery } from '../identify/match.ts';
import {
  applyMatchAction,
  itemMatchSummary,
  rememberSearch,
  scoreSearchResults,
  setReviewState,
  validateMatchAction,
} from '../lib/identityReview.ts';
import type { FolderReachability } from '../lib/library.ts';
import { coverageByKind, matchReport } from '../lib/matchReport.ts';
import { applyUserPatch } from '../lib/progress.ts';
import { loadRankData } from '../lib/rankData.ts';
import {
  buildCard,
  ineligibleBecause,
  readNext,
  TIME_PRESETS,
  type TimeMode,
} from '../lib/recommend.ts';
import { bulkReview } from '../lib/review.ts';
import type { ScanManager } from '../scan/scanManager.ts';
import { HARDCOVER_NEW_TOKEN_URL, normaliseToken } from '../sources/hardcover.ts';
import { getSecret, maskSecret, setSecret, type Sources } from '../sources/index.ts';
import { SourceError, SOURCE_LABELS } from '../sources/types.ts';
import { HttpError, newId, nowIso, parseJson, todayLocal } from '../util.ts';
import { route } from './route.ts';

/**
 * Milestone 3 routes: lookups, Read next, "Not this, because…", triage, identity review and
 * the Hardcover token. GET requests never change anything (§6.3).
 */

export interface ReadingDeps {
  db: DB;
  sources: Sources;
  lookups: LookupManager;
  scans: ScanManager;
  reach: () => Promise<FolderReachability>;
  itemIdOr404: (raw: string) => string;
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
    string | undefined;
  return parseJson<T>(v, fallback);
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The time control from the query string: a preset id, and "read_for" or "finish_within". */
function situationFrom(req: Request) {
  const preset = TIME_PRESETS.find((p) => p.id === str(req.query.time)) ?? TIME_PRESETS.at(-1)!;
  const mode: TimeMode = req.query.mode === 'finish_within' ? 'finish_within' : 'read_for';
  const exclude = new Set((str(req.query.exclude) ?? '').split(',').filter(Boolean).slice(0, 500));
  return {
    budget: preset.minutes,
    mode,
    readyToRead: req.query.ready === '1',
    show: (req.query.show === 'books' || req.query.show === 'comics' ? req.query.show : 'all') as
      'all' | 'books' | 'comics',
    exclude,
    today: todayLocal(),
    recentDays: RECENT_DAYS,
    presetId: preset.id,
  };
}

const FEEDBACK_REASONS = [
  'already_read',
  'wrong_book',
  'not_in_mood',
  'not_interested',
  'other',
] as const;

export function registerReadingRoutes(app: Express, d: ReadingDeps): void {
  const { db, sources, lookups } = d;

  // ---- Read next (§13.10) ------------------------------------------------------------------
  app.get(
    '/api/next',
    route(async (req) => {
      const s = situationFrom(req);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const data = loadRankData(db, await d.reach());
      const r = readNext(data.items, s, { offset, limit: READ_NEXT_PAGE });
      return {
        ...r,
        situation: { time: s.presetId, mode: s.mode, ready: s.readyToRead, show: s.show },
        presets: TIME_PRESETS,
        lookups: { pending: lookups.pending(), running: lookups.isRunning() },
        hardcover: sources.demo ? null : sources.hardcover.configured(),
      };
    }),
  );

  // ---- "Not this, because…" (§13.8) ------------------------------------------------------------
  app.post(
    '/api/feedback',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const itemId = d.itemIdOr404(String(b.itemId ?? ''));
      const reason = b.reason as (typeof FEEDBACK_REASONS)[number];
      if (!FEEDBACK_REASONS.includes(reason))
        throw new HttpError(400, `reason must be one of ${FEEDBACK_REASONS.join(', ')}.`);
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) || null : null;
      const mode = typeof b.mode === 'string' ? b.mode.slice(0, 40) : 'read_next';
      const situation = b.situation && typeof b.situation === 'object' ? b.situation : {};
      db.transaction(() => {
        db.prepare(
          `INSERT INTO pick_feedback (id, item_id, mode, situation, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId(),
          itemId,
          mode,
          JSON.stringify(situation).slice(0, 2000),
          reason,
          note,
          nowIso(),
        );
        if (reason === 'already_read') {
          // Read, date unknown unless given — never today's date as a stand-in (§13.6).
          applyUserPatch(db, itemId, { progress: 'finished', finishedPrecision: 'unknown' });
        } else if (reason === 'wrong_book') {
          applyUserPatch(db, itemId, {});
          db.prepare(
            'UPDATE user_item SET wrong_match_at = ?, updated_at = ? WHERE item_id = ?',
          ).run(nowIso(), nowIso(), itemId);
        }
      })();
      return { ok: true };
    }),
  );

  // ---- Triage (§13.5) ----------------------------------------------------------------------
  // Untriaged, not started, eligible, not reference: rated and measured first, so the first
  // session shows the books most worth a decision. Skipped items stay in the browser's session.
  app.get(
    '/api/triage',
    route(async (req) => {
      const data = loadRankData(db, await d.reach());
      const skip = new Set((str(req.query.skip) ?? '').split(',').filter(Boolean).slice(0, 1000));
      const queue = data.items.filter(
        (i) =>
          i.user.triage === null &&
          i.user.progress === 'not_started' &&
          !i.isReference &&
          ineligibleBecause(i) === null &&
          !skip.has(i.id),
      );
      queue.sort(
        (a, b) =>
          Number(!!b.community) - Number(!!a.community) ||
          (b.community?.score ?? 0) - (a.community?.score ?? 0) ||
          a.title.localeCompare(b.title),
      );
      const s = {
        budget: null,
        mode: 'read_for' as const,
        readyToRead: false,
        exclude: new Set<string>(),
        today: todayLocal(),
        recentDays: RECENT_DAYS,
      };
      const limit = Math.min(Number(req.query.limit) || TRIAGE_SESSION, 100);
      const triaged = data.items.filter((i) => i.user.triage !== null).length;
      return {
        remaining: queue.length,
        triaged,
        items: queue.slice(0, limit).map((i) => ({
          ...buildCard(i, data.items, s),
          kindIsGuess: data.library.get(i.id)?.kindIsGuess ?? false,
          description:
            data.used.get(i.id)?.find((m) => m.record.description)?.record.description ?? null,
          firstPublishYear: i.firstPublishYear,
        })),
      };
    }),
  );

  // ---- Lookups (§12.1) -----------------------------------------------------------------------
  app.get(
    '/api/lookups',
    route(() => ({
      status: lookups.status(),
      pending: lookups.pending(),
      sources: sources.status(),
      afterScan: getSetting(db, 'lookupsAfterScan', true),
    })),
  );
  app.post(
    '/api/lookups',
    route((req) => {
      if (d.scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      return { status: lookups.start({ refresh: req.body?.refresh === true }) };
    }),
  );
  app.post(
    '/api/lookups/cancel',
    route(() => ({ cancelled: lookups.requestCancel() })),
  );
  app.patch(
    '/api/settings/lookups',
    route((req) => {
      if (typeof req.body?.afterScan !== 'boolean')
        throw new HttpError(400, 'afterScan must be true or false.');
      setSetting(db, 'lookupsAfterScan', req.body.afterScan);
      return { ok: true };
    }),
  );

  // ---- Hardcover token (§6.3, §12.1): never in backups, masked unless Show is pressed -------
  app.get(
    '/api/settings/hardcover',
    route(() => ({
      configured: !!getSecret(db, 'hardcover_token'),
      masked: maskSecret(getSecret(db, 'hardcover_token')),
      newTokenUrl: HARDCOVER_NEW_TOKEN_URL,
    })),
  );
  app.get(
    '/api/settings/hardcover/reveal',
    route(() => ({ token: getSecret(db, 'hardcover_token') })),
  );
  app.put(
    '/api/settings/hardcover',
    route((req) => {
      const t = req.body?.token;
      if (t !== null && typeof t !== 'string')
        throw new HttpError(400, 'token must be text or null.');
      const clean = t === null ? null : normaliseToken(t);
      if (clean !== null && !/^[\w.\-~+/=]{20,4000}$/.test(clean))
        throw new HttpError(
          400,
          'That doesn’t look like a Hardcover token. Copy it again from Hardcover.',
        );
      setSecret(db, 'hardcover_token', clean);
      return { ok: true, configured: !!clean };
    }),
  );

  // Diagnostics → Test Hardcover (§12.1): a few real lookups from the library, with what came
  // back and the rate-limit headers. Titles are left out unless the owner ticks the box.
  app.post(
    '/api/diagnostics/hardcover-test',
    route(async (req) => {
      if (!sources.hardcover.configured())
        throw new HttpError(400, 'Enter a Hardcover token in Settings first.');
      const names = req.body?.names === true;
      const ids = db
        .prepare(
          `SELECT i.id FROM items i LEFT JOIN user_item u ON u.item_id = i.id
           WHERE COALESCE(u.kind_override, i.kind, '') NOT IN ('comic', 'manga')
           ORDER BY (i.title_source = 'embedded') DESC, random() LIMIT 3`,
        )
        .pluck()
        .all() as string[];
      const results = [];
      for (const [n, id] of ids.entries()) {
        const facts = matchFactsFor(db, id)!;
        const q = buildQuery(facts);
        try {
          const recs = await sources.hardcover.search(q, { refresh: true });
          const top = recs[0];
          results.push({
            book: names ? q.title : `Book ${n + 1}`,
            results: recs.length,
            top: top
              ? {
                  title: names ? top.title : undefined,
                  rating: top.rating ? `${top.rating.value}/5` : 'none',
                  ratingsCount: top.rating?.count ?? 0,
                  pages: top.pages ?? null,
                  series: top.series
                    ? `${names ? top.series.name : 'yes'}${top.series.position ? ` #${top.series.position}` : ''}`
                    : null,
                  year: top.firstPublishYear ?? null,
                  genres: top.subjects.length,
                }
              : null,
          });
        } catch (e) {
          results.push({ book: names ? q.title : `Book ${n + 1}`, error: (e as Error).message });
        }
      }
      const st = sources.hardcover.client.status();
      return {
        ok: results.every((r) => !('error' in r)),
        results,
        rateLimit: st.rateLimit,
        requestsToday: sources.hardcover.usageToday(),
      };
    }),
  );

  // ---- One item's online identity (§11.4) ----------------------------------------------------
  app.get(
    '/api/items/:id/online',
    route(async (req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const data = loadRankData(db, await d.reach());
      const i = data.items.find((x) => x.id === id);
      const s = {
        budget: null,
        mode: 'read_for' as const,
        readyToRead: false,
        exclude: new Set<string>(),
        today: todayLocal(),
        recentDays: RECENT_DAYS,
      };
      const used = data.used.get(id) ?? [];
      return {
        identity: i?.identity ?? 'unidentified',
        matchConfirmed: i?.matchConfirmed ?? false,
        ...itemMatchSummary(db, id),
        community: i?.community ?? null,
        duration: i?.duration ?? null,
        effort: i?.effort ?? 'unknown',
        firstPublishYear: i?.firstPublishYear ?? null,
        acquired: i?.acquired ?? null,
        eligibleBecause: i ? ineligibleBecause(i) : null,
        card: i ? buildCard(i, data.items, s) : null,
        // Text from sources: shown as text only (§6.3, scenario 23).
        description: used.find((m) => m.record.description)?.record.description ?? null,
        subjects: [...new Set(used.flatMap((m) => m.record.subjects))].slice(0, 12),
        lookupAvailable:
          sources.forItem(
            i?.kind ?? null,
            db.prepare('SELECT issue_label FROM items WHERE id = ?').pluck().get(id) as
              string | null,
          ).length > 0,
      };
    }),
  );
  app.post(
    '/api/items/:id/match',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const a = validateMatchAction(req.body);
      db.transaction(() => applyMatchAction(db, id, a))();
      return { ok: true };
    }),
  );
  app.post(
    '/api/items/:id/lookup',
    route(async (req) => {
      const id = d.itemIdOr404(String(req.params.id));
      if (lookups.isRunning())
        throw new HttpError(409, 'Lookups are running; this book will be included.');
      const r = await lookUpItem(db, sources, id, { refresh: true });
      return { results: r.map((x) => ({ ...x, sourceLabel: SOURCE_LABELS[x.source] })) };
    }),
  );
  // Search and pick: a POST because it may call online sources, though it changes nothing here.
  app.post(
    '/api/items/:id/search',
    route(async (req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const q = String(req.body?.query ?? '').trim();
      if (q.length < 2) throw new HttpError(400, 'Type at least two letters.');
      if (q.length > 200) throw new HttpError(400, 'That search is too long.');
      const facts = matchFactsFor(db, id);
      const author =
        typeof req.body?.author === 'string' ? req.body.author.trim().slice(0, 100) : '';
      const records = [];
      const errors: string[] = [];
      for (const s of sources.forSearch(facts?.kind ?? null)) {
        try {
          records.push(
            ...(await s.search({ title: q, author: author || undefined, series: undefined })),
          );
        } catch (e) {
          errors.push(
            e instanceof SourceError
              ? `${SOURCE_LABELS[e.source]}: ${e.message}`
              : (e as Error).message,
          );
        }
      }
      rememberSearch(id, records);
      return { candidates: scoreSearchResults(db, id, records), errors };
    }),
  );

  // ---- Needs review: Defer, Dismiss, confirm all like this (§11.4) ---------------------------
  app.post(
    '/api/review-state',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.key !== 'string' || b.key.length > 200)
        throw new HttpError(400, 'key is required.');
      if (b.state !== 'deferred' && b.state !== 'dismissed' && b.state !== null)
        throw new HttpError(400, 'state must be "deferred", "dismissed" or null.');
      const until =
        typeof b.until === 'string' && !Number.isNaN(Date.parse(b.until))
          ? new Date(b.until).toISOString()
          : undefined;
      setReviewState(db, b.key, b.state, until);
      return { ok: true };
    }),
  );
  app.post(
    '/api/review/bulk',
    route((req) => {
      if (d.scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
      const kind = req.body?.kind;
      const action = req.body?.action;
      if (kind !== 'cross_folder' && kind !== 'move')
        throw new HttpError(400, 'kind must be cross_folder or move.');
      if (action !== 'accept' && action !== 'decline')
        throw new HttpError(400, 'action must be accept or decline.');
      return bulkReview(db, kind, action, req.body?.preview !== false);
    }),
  );
  app.get(
    '/api/match-report',
    route(async () => ({
      ...matchReport(db, (kind, issue) => sources.forItem(kind, issue).length > 0),
      coverage: coverageByKind(loadRankData(db, await d.reach()).items),
    })),
  );
}
