import type { Express } from 'express';
import { RECENT_DAYS, STILL_READING_SNOOZE_DAYS, WEIGHTS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { loadLibrary, type FolderReachability } from '../lib/library.ts';
import { stillReadingDue } from '../lib/modes.ts';
import { applyUserPatch, ensureUserRow, DNF_REASONS } from '../lib/progress.ts';
import { loadRankData } from '../lib/rankData.ts';
import { buildCard } from '../lib/recommend.ts';
import { tasteSummary } from '../lib/taste.ts';
import {
  loadStrength,
  loadTopics,
  loadWeights,
  resetWeights,
  saveStrength,
  saveTopics,
  saveWeights,
  tasteFrom,
  WEIGHT_TEXT,
} from '../lib/tune.ts';
import { HttpError, newId, nowIso, todayLocal } from '../util.ts';
import { route } from './route.ts';

/**
 * Milestone 5 routes: Tune (§13.7), taste (§13.11), topic interests, Still reading? (§13.6),
 * the Still relevant? actions (§13.10) and bulk triage with undo (§13.5).
 */

export interface ModeDeps {
  db: DB;
  reach: () => Promise<FolderReachability>;
  itemIdOr404: (raw: string) => string;
}

const plainSituation = () => ({
  budget: null,
  mode: 'read_for' as const,
  readyToRead: false,
  exclude: new Set<string>(),
  today: todayLocal(),
  recentDays: RECENT_DAYS,
});

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Triage undo: the exact prior fields of each touched item, kept in memory. `after` is the whole
 * owner row just after the action, so Undo can tell whether anything changed since. Comparing the
 * row, not `updated_at`, matters: two edits in the same millisecond share a timestamp.
 */
interface BulkUndo {
  id: string;
  rows: { item_id: string; before: Record<string, unknown> | null; after: string }[];
}
type TriageAction = 'want' | 'maybe' | 'never' | 'read';
/** Undo depth: bulk selections can be large, so fewer are kept; one-at-a-time matches the page. */
const BULK_UNDO_KEPT = 10;
const ONE_UNDO_KEPT = 50;
const BULK_FIELDS = [
  'progress',
  'dnf_reason',
  'started_on',
  'started_precision',
  'finished_on',
  'finished_precision',
  'progress_at',
  'triage',
  'triage_at',
  'updated_at',
] as const;

export function registerModeRoutes(app: Express, d: ModeDeps): void {
  const { db } = d;
  const bulkUndos: BulkUndo[] = [];
  const oneUndos: BulkUndo[] = [];

  // ---- Tune (§13.7) and taste (§13.11) ------------------------------------------------------
  app.get(
    '/api/tune',
    route(async () => {
      const data = loadRankData(db, await d.reach());
      const strength = loadStrength(db);
      return {
        weights: loadWeights(db),
        defaults: WEIGHTS,
        explain: WEIGHT_TEXT,
        strength,
        taste: tasteSummary(tasteFrom(data.items, strength)),
      };
    }),
  );
  app.put(
    '/api/tune',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(b))
        if (k !== 'weights' && k !== 'strength') throw new HttpError(400, `Unknown field "${k}".`);
      const out: Record<string, unknown> = {};
      db.transaction(() => {
        if ('weights' in b) out.weights = saveWeights(db, b.weights);
        if ('strength' in b) out.strength = saveStrength(db, b.strength);
      })();
      return { ok: true, ...out };
    }),
  );
  app.post(
    '/api/tune/reset',
    route(() => {
      resetWeights(db);
      return { ok: true, weights: loadWeights(db) };
    }),
  );

  // ---- Topic interests ------------------------------------------------------------------------
  app.get(
    '/api/settings/topics',
    route(() => ({ topics: loadTopics(db) })),
  );
  app.put(
    '/api/settings/topics',
    route((req) => ({ topics: saveTopics(db, req.body?.topics) })),
  );

  // ---- Still reading? (§13.6): one digest, never a stream of prompts -------------------------
  app.get(
    '/api/still-reading',
    route(async () => {
      const data = loadRankData(db, await d.reach());
      const s = plainSituation();
      return {
        items: stillReadingDue(data.items, s.today).map((i) => ({
          ...buildCard(i, data.items, s),
          lastTouched: i.user.progressAt,
        })),
      };
    }),
  );
  app.post(
    '/api/still-reading/:id',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const action = req.body?.action;
      db.transaction(() => {
        ensureUserRow(db, id);
        if (action === 'still') {
          // Still reading: touched today, so the 90 days start again. Progress stays as it is.
          db.prepare(
            'UPDATE user_item SET progress_at = ?, still_reading_snoozed_until = NULL, updated_at = ? WHERE item_id = ?',
          ).run(nowIso(), nowIso(), id);
        } else if (action === 'snooze') {
          db.prepare(
            'UPDATE user_item SET still_reading_snoozed_until = ?, updated_at = ? WHERE item_id = ?',
          ).run(addDays(todayLocal(), STILL_READING_SNOOZE_DAYS), nowIso(), id);
        } else if (action === 'not_started') {
          applyUserPatch(db, id, { progress: 'not_started' });
        } else if (action === 'dnf') {
          const reason = req.body?.dnfReason ?? null;
          if (reason !== null && !(DNF_REASONS as readonly string[]).includes(reason))
            throw new HttpError(400, `dnfReason must be one of ${DNF_REASONS.join(', ')} or null.`);
          applyUserPatch(db, id, { progress: 'dnf', dnfReason: reason });
        } else throw new HttpError(400, 'action must be still, snooze, not_started or dnf.');
      })();
      return { ok: true };
    }),
  );

  // ---- Still relevant? actions (§13.10): Want / Mark as reference / Never / Decide later ------
  app.post(
    '/api/items/:id/relevance',
    route((req) => {
      const id = d.itemIdOr404(String(req.params.id));
      const action = req.body?.action;
      db.transaction(() => {
        if (action === 'want') applyUserPatch(db, id, { triage: 'want' });
        else if (action === 'never') applyUserPatch(db, id, { triage: 'never' });
        else if (action === 'reference') applyUserPatch(db, id, { referenceOverride: true });
        else if (action === 'later' || action === 'undo_later') {
          ensureUserRow(db, id);
          db.prepare(
            'UPDATE user_item SET relevance_deferred_at = ?, updated_at = ? WHERE item_id = ?',
          ).run(action === 'later' ? nowIso() : null, nowIso(), id);
        } else throw new HttpError(400, 'action must be want, reference, never or later.');
      })();
      return { ok: true };
    }),
  );

  // ---- Bulk triage (§13.5): Already read / Never on a selection, with preview and undo -------
  app.post(
    '/api/triage/bulk',
    route(async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const action = b.action;
      if (action !== 'read' && action !== 'never')
        throw new HttpError(400, 'action must be read or never.');
      if (!Array.isArray(b.ids) || b.ids.length === 0)
        throw new HttpError(400, 'Choose at least one item.');
      if (b.ids.length > 2000) throw new HttpError(400, 'At most 2,000 items at once.');
      const ids = [...new Set(b.ids.map((x) => d.itemIdOr404(String(x))))];
      const titles = new Map(
        loadLibrary(db, await d.reach(), ids).items.map((i) => [i.id, i.title]),
      );
      const rows = ids.map(
        (id) =>
          [
            id,
            db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(id) as
              Record<string, unknown> | undefined,
            titles.get(id)!,
          ] as const,
      );
      // What changes, and what the owner would want to know first: progress already recorded
      // that "Already read" replaces, books on the shortlist, and those already in that state.
      const inProgress = rows.filter(
        ([, u]) => u && u.progress !== 'not_started' && u.progress !== 'finished',
      );
      const already = rows.filter(([, u]) =>
        action === 'read' ? u?.progress === 'finished' : u?.triage === 'never',
      );
      const shortlisted = rows.filter(([, u]) => u && u.shortlist_position !== null);
      const preview = {
        action,
        count: ids.length,
        changes: ids.length - already.length,
        already: already.length,
        inProgress: inProgress.map(([id, u, title]) => ({ id, title, progress: u!.progress })),
        shortlisted: shortlisted.map(([id, , title]) => ({ id, title })),
      };
      if (b.preview !== false) return { preview };
      const changing = rows
        .filter(([, u]) => (action === 'read' ? u?.progress !== 'finished' : u?.triage !== 'never'))
        .map(([id]) => id);
      const undo = applyWithUndo(changing, action);
      bulkUndos.unshift(undo);
      bulkUndos.splice(BULK_UNDO_KEPT);
      return { preview, done: undo.rows.length, undo: undo.id };
    }),
  );

  // ---- One-at-a-time triage (§13.5): the same before-state undo as bulk, one book at a time ---
  app.post(
    '/api/triage/one',
    route((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const action = b.action;
      if (action !== 'want' && action !== 'maybe' && action !== 'never' && action !== 'read')
        throw new HttpError(400, 'action must be want, maybe, never or read.');
      const id = d.itemIdOr404(String(b.id));
      const undo = applyWithUndo([id], action);
      oneUndos.unshift(undo);
      oneUndos.splice(ONE_UNDO_KEPT);
      return { undo: undo.id };
    }),
  );

  /**
   * Undo puts back each book's exact earlier fields, unless it was edited since: a newer
   * decision (from another tab, the book page or anywhere else) is left alone and counted.
   */
  const undoRoute = route((req) => {
    for (const pool of [bulkUndos, oneUndos]) {
      const at = pool.findIndex((u) => u.id === req.body?.undo);
      if (at < 0) continue;
      const result = restore(pool[at]!);
      pool.splice(at, 1);
      return result;
    }
    throw new HttpError(404, 'That can no longer be undone.');
  });
  app.post('/api/triage/undo', undoRoute);
  app.post('/api/triage/bulk/undo', undoRoute);

  function applyWithUndo(ids: string[], action: TriageAction): BulkUndo {
    const undo: BulkUndo = { id: newId(), rows: [] };
    db.transaction(() => {
      for (const id of ids) {
        const u = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(id) as
          Record<string, unknown> | undefined;
        const before = u ? Object.fromEntries(BULK_FIELDS.map((f) => [f, u[f]])) : null;
        // Already read: date unknown, never today's date as a stand-in (§13.6).
        if (action === 'read')
          applyUserPatch(db, id, { progress: 'finished', finishedPrecision: 'unknown' });
        else applyUserPatch(db, id, { triage: action });
        undo.rows.push({ item_id: id, before, after: ownerRow(id) });
      }
    })();
    return undo;
  }

  /** The item's whole owner row, as comparable text ('' when it has none). */
  function ownerRow(id: string): string {
    const row = db.prepare('SELECT * FROM user_item WHERE item_id = ?').get(id);
    return row ? JSON.stringify(row) : '';
  }

  function restore(u: BulkUndo): { restored: number; skipped: number } {
    let restored = 0;
    const skipped: string[] = [];
    db.transaction(() => {
      for (const r of u.rows) {
        // Edited since (any field, even within the same millisecond): leave the newer change
        // alone rather than overwrite it.
        if (ownerRow(r.item_id) !== r.after) {
          skipped.push(r.item_id);
          continue;
        }
        if (r.before === null) {
          db.prepare(
            `UPDATE user_item SET progress = 'not_started', dnf_reason = NULL, started_on = NULL,
                 started_precision = NULL, finished_on = NULL, finished_precision = NULL,
                 progress_at = NULL, triage = NULL, triage_at = NULL, updated_at = ?
               WHERE item_id = ?`,
          ).run(nowIso(), r.item_id);
        } else {
          db.prepare(
            `UPDATE user_item SET ${BULK_FIELDS.map((f) => `${f} = @${f}`).join(', ')}
               WHERE item_id = @item_id`,
          ).run({ ...r.before, item_id: r.item_id });
        }
        restored++;
      }
    })();
    return { restored, skipped: skipped.length };
  }
}
