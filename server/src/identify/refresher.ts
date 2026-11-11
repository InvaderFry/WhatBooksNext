import {
  REFRESH_BATCH_REQUESTS,
  REFRESH_CHECK_MS,
  REFRESH_DAILY_SHARE,
  REFRESH_FIRST_CHECK_MS,
  RESTORE_SNAPSHOTS_KEPT,
} from '../config.ts';
import type { DB } from '../db/database.ts';
import { takeSnapshot } from '../db/snapshots.ts';
import { historyOnlyIds } from '../lib/library.ts';
import { publicationPending, publicationSeries, refreshPublications } from '../lib/publications.ts';
import {
  DAILY_LIMITS,
  dueAt,
  dueItems,
  freshEstimate,
  REQUESTS_PER_LOOKUP,
  type RefreshRow,
} from '../lib/refresh.ts';
import { RATING_SUPPORTED_VOTES } from '../config.ts';
import type { Sources } from '../sources/index.ts';
import { DailyUsage } from '../sources/usage.ts';
import { SOURCE_LABELS, SourceError, type SourceName } from '../sources/types.ts';
import { HttpError, nowIso, parseJson, todayLocal } from '../util.ts';
import {
  allMatchInputs,
  decisionsFor,
  itemsNeedingLookup,
  lookUpItem,
  matchFactsFor,
  matchesOf,
  nextLocalDay,
  type LookupManager,
  type LookupStatus,
  type MatchRow,
} from './lookups.ts';
import { syncSeries } from './series.ts';

/**
 * Automatic refresh (ratings plan stage 4), built around the LookupManager rather than as a
 * second lookup engine. A few minutes after start and then every ten minutes, one batch of at
 * most REFRESH_BATCH_REQUESTS real requests: new books first, then books in progress or
 * shortlisted, then the most overdue. Never in the demo, during a scan or a lookup run, or while
 * the owner's "Look up all books again" is under way (which this also keeps going across days
 * and restarts).
 */

const IN_PROGRESS = new Set(['sampled', 'into_it', 'halfway', 'nearly_done']);

export interface BatchReport {
  at: string;
  books: number;
  requests: number;
  bySource: Partial<Record<SourceName, number>>;
  /** Why it ended early, in plain words, if it did. */
  stopped: string | null;
}

interface FreshState {
  startedAt: string;
  /** A pass is under way (true across a restart: it resumes at once). */
  inPass: boolean;
  passes: number;
  lastPassDay: string | null;
  lastRemaining: number | null;
  snapshot: string | null;
}

const FRESH_KEY = 'freshLookup';

function getSetting<T>(db: DB, key: string, fallback: T): T {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
    string | undefined;
  return parseJson<T>(v, fallback);
}

function setSetting(db: DB, key: string, value: unknown): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

/** Does any trusted match (owner-confirmed or app-accepted) give a supported rating? */
export function wellRated(
  matches: MatchRow[],
  override: string | null,
  rejected: Set<string>,
): boolean {
  if (override === 'none') return false;
  const trusted: MatchRow[] = [];
  const confirmed = override ? matches.find((m) => `${m.source}:${m.sourceId}` === override) : null;
  if (confirmed) trusted.push(confirmed);
  for (const [source, d] of decisionsFor(matches, rejected))
    if (d.decision === 'accepted' && d.best && source !== confirmed?.source) trusted.push(d.best);
  return trusted.some(
    (m) =>
      m.record.rating &&
      m.record.rating.scope !== 'series' &&
      (m.record.rating.count ?? 0) >= RATING_SUPPORTED_VOTES,
  );
}

/** Every applicable lookup_state row with what decides its group (or one book's rows). */
export function loadRefreshRows(db: DB, sources: Sources, itemId?: string): RefreshRow[] {
  const rows = db
    .prepare(
      `SELECT l.item_id, l.source, l.outcome, l.looked_up_at, l.last_answer_at,
         l.next_eligible_at, l.failure_count, COALESCE(u.kind_override, i.kind) AS kind,
         i.issue_label, u.progress, u.shortlist_position, u.triage, COALESCE(u.hidden, 0) AS hidden
       FROM lookup_state l JOIN items i ON i.id = l.item_id
       LEFT JOIN user_item u ON u.item_id = i.id
       ${itemId ? 'WHERE l.item_id = ?' : ''}`,
    )
    .all(...(itemId ? [itemId] : [])) as {
    item_id: string;
    source: SourceName;
    outcome: string;
    looked_up_at: string;
    last_answer_at: string | null;
    next_eligible_at: string | null;
    failure_count: number;
    kind: string | null;
    issue_label: string | null;
    progress: string | null;
    shortlist_position: number | null;
    triage: string | null;
    hidden: number;
  }[];
  const elsewhere = historyOnlyIds(db);
  const inputs = itemId
    ? {
        matches: new Map([[itemId, matchesOf(db, itemId)]]),
        rejected: new Map([
          [
            itemId,
            new Set(
              (
                db
                  .prepare('SELECT source, source_id FROM candidates_rejected WHERE item_id = ?')
                  .all(itemId) as { source: string; source_id: string }[]
              ).map((r) => `${r.source}:${r.source_id}`),
            ),
          ],
        ]),
        overrides: new Map(
          (
            db
              .prepare('SELECT item_id, match_override FROM user_item WHERE item_id = ?')
              .all(itemId) as { item_id: string; match_override: string | null }[]
          )
            .filter((r) => r.match_override !== null)
            .map((r) => [r.item_id, r.match_override!]),
        ),
      }
    : allMatchInputs(db);
  const { matches, rejected, overrides } = inputs;
  const rated = new Map<string, boolean>();
  const out: RefreshRow[] = [];
  for (const r of rows) {
    if (!sources.forItem(r.kind, r.issue_label).some((s) => s.name === r.source)) continue;
    if (!rated.has(r.item_id))
      rated.set(
        r.item_id,
        wellRated(
          matches.get(r.item_id) ?? [],
          overrides.get(r.item_id) ?? null,
          rejected.get(r.item_id) ?? new Set(),
        ),
      );
    out.push({
      itemId: r.item_id,
      source: r.source,
      outcome: r.outcome,
      lookedUpAt: r.looked_up_at,
      lastAnswerAt: r.last_answer_at,
      nextEligibleAt: r.next_eligible_at,
      failureCount: r.failure_count,
      active: r.shortlist_position !== null || IN_PROGRESS.has(r.progress ?? ''),
      quiet: r.triage === 'never' || r.hidden === 1 || elsewhere.has(r.item_id),
      wellRated: rated.get(r.item_id)!,
    });
  }
  return out;
}

export class RefreshScheduler {
  private readonly db: DB;
  private readonly sources: Sources;
  private readonly lookups: LookupManager;
  private readonly scans: { isRunning(): boolean };
  private readonly demo: boolean;
  private readonly now: () => number;
  private readonly budget: number;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private batch: Promise<BatchReport> | null = null;
  private stopRequested = false;
  private holds = 0;
  private closed = false;
  /** Paused by the owner until Resume or a restart. */
  private paused = false;
  /** A source whose daily allowance ran out, until the next local day. */
  private readonly quotaUntil = new Map<SourceName, number>();
  private readonly usage = new Map<SourceName, DailyUsage>();
  lastCheckAt: string | null = null;
  lastBatch: BatchReport | null = null;

  constructor(
    db: DB,
    sources: Sources,
    lookups: LookupManager,
    scans: { isRunning(): boolean },
    opts: { demo?: boolean; now?: () => number; batchRequests?: number } = {},
  ) {
    this.db = db;
    this.sources = sources;
    this.lookups = lookups;
    this.scans = scans;
    this.demo = Boolean(opts.demo);
    this.now = opts.now ?? Date.now;
    this.budget = opts.batchRequests ?? REFRESH_BATCH_REQUESTS;
    lookups.setBackgroundStop(() => this.stop());
    lookups.afterRun = (s) => this.afterRun(s);
  }

  /** On unless the owner turned it off; never in the demo. */
  enabled(): boolean {
    return !this.demo && getSetting(this.db, 'autoRefresh', true);
  }

  setEnabled(on: boolean): void {
    setSetting(this.db, 'autoRefresh', on);
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  /** Starts the periodic checks (the app does; tests call check() themselves). */
  startTimers(): void {
    if (this.demo || this.closed) return;
    const tick = () => {
      this.check().catch((err) => console.error(err));
    };
    const first = setTimeout(() => {
      tick();
      const every = setInterval(tick, REFRESH_CHECK_MS);
      every.unref?.();
      this.timers.push(every);
    }, REFRESH_FIRST_CHECK_MS);
    first.unref?.();
    this.timers.push(first);
  }

  /** Stops the current batch after the book it is on, and waits for it. */
  async stop(): Promise<void> {
    if (!this.batch) return;
    this.stopRequested = true;
    try {
      await this.batch;
    } catch {
      /* reported where it ran */
    } finally {
      this.stopRequested = false;
    }
  }

  /** Runs the owner's own work (Look up again on a book page) with no batch alongside it. */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      await this.stop();
      return await fn();
    } finally {
      this.holds--;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    await this.stop();
  }

  isBusy(): boolean {
    return this.batch !== null;
  }

  private usageOf(s: SourceName): DailyUsage {
    if (!this.usage.has(s)) this.usage.set(s, new DailyUsage(this.db, `refreshUsage:${s}`));
    return this.usage.get(s)!;
  }

  /** Why automatic work leaves this source alone right now, or null. */
  private blocked(s: SourceName): string | null {
    if (this.sources.isPaused(s)) return 'paused after repeated failures';
    const q = this.quotaUntil.get(s);
    if (q !== undefined && q > this.now()) return 'daily allowance used up; carrying on tomorrow';
    const limit = DAILY_LIMITS[s];
    if (limit && this.usageOf(s).today() >= limit * REFRESH_DAILY_SHARE)
      return 'automatic share of today’s allowance used';
    return null;
  }

  /** One check: resume "Look up all books again" if it is waiting, else one batch. */
  async check(): Promise<BatchReport | null> {
    if (this.demo || this.closed) return null;
    this.lastCheckAt = new Date(this.now()).toISOString();
    if (this.scans.isRunning() || this.lookups.isRunning() || this.batch || this.holds > 0)
      return null;
    const fresh = this.freshState();
    if (fresh) {
      if (fresh.inPass || fresh.lastPassDay !== todayLocal(new Date(this.now())))
        this.resumeFresh(fresh);
      return null;
    }
    if (!this.enabled() || this.paused) return null;
    const p = this.runBatch();
    this.batch = p;
    try {
      return await p;
    } finally {
      this.batch = null;
    }
  }

  /** Books never looked up (or whose search changed), then due ones, in order. */
  private plan(): { itemId: string; isNew: boolean; sources: SourceName[] | null }[] {
    const first = getSetting(this.db, 'lookupsAfterScan', true)
      ? itemsNeedingLookup(this.db, this.sources, false, false)
      : [];
    const seen = new Set(first);
    return [
      ...first.map((itemId) => ({ itemId, isNew: true, sources: null })),
      ...dueItems(loadRefreshRows(this.db, this.sources), this.now())
        .filter((d) => !seen.has(d.itemId))
        .map((d) => ({ itemId: d.itemId, isNew: false, sources: d.sources })),
    ];
  }

  private async runBatch(): Promise<BatchReport> {
    const report: BatchReport = {
      at: new Date(this.now()).toISOString(),
      books: 0,
      requests: 0,
      bySource: {},
      stopped: null,
    };
    const counted: SourceName[] = ['openlibrary', 'anilist', 'hardcover', 'metron', 'comicvine'];
    const count = () => new Map(counted.map((s) => [s, this.sources.requestCount(s)]));
    const add = (before: Map<SourceName, number>) => {
      for (const [s, n] of count()) {
        const d = n - (before.get(s) ?? 0);
        if (d <= 0) continue;
        report.requests += d;
        report.bySource[s] = (report.bySource[s] ?? 0) + d;
        this.usageOf(s).count(d);
      }
    };
    const interrupted = () =>
      this.stopRequested || this.closed || this.scans.isRunning() || this.lookups.isRunning();
    let changed = false;
    for (const p of this.plan()) {
      if (interrupted()) {
        report.stopped = 'Other work started.';
        break;
      }
      if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(p.itemId)) continue;
      let wanted = p.sources;
      if (!wanted) {
        const f = matchFactsFor(this.db, p.itemId);
        if (!f) continue;
        wanted = this.sources.forItem(f.kind, f.issue ?? null).map((s) => s.name);
      }
      const srcs = wanted.filter((s) => this.blocked(s) === null);
      if (srcs.length === 0) continue;
      const estimate = srcs.reduce((a, s) => a + REQUESTS_PER_LOOKUP[s], 0);
      if (report.requests > 0 && report.requests + estimate > this.budget) break;
      const before = count();
      try {
        const results = await lookUpItem(
          this.db,
          this.sources,
          p.itemId,
          // A new book is looked up as a manual run would (cached answers welcome); a due one
          // asks its due sources again, keeping what it had if the answer is unclear.
          p.isNew ? { only: srcs } : { refresh: true, background: true, only: srcs },
        );
        for (const r of results)
          if (r.quota) this.quotaUntil.set(r.source, Date.parse(nextLocalDay()));
      } catch (err) {
        console.error(err);
      }
      add(before);
      report.books++;
      changed = true;
    }
    if (changed) {
      // What the batch learned about series (names, order, finished or ongoing) takes effect.
      syncSeries(this.db);
      this.lookups.invalidate();
    }
    // Ongoing series' weekly published-volume check shares the batch's budget.
    if (!interrupted() && this.blocked('hardcover') === null)
      for (const id of publicationSeries(this.db, this.sources)) {
        if (interrupted() || report.requests + 2 > this.budget) break;
        if (!publicationPending(this.db, id)) continue;
        const before = count();
        try {
          await refreshPublications(this.db, this.sources, id, false);
        } catch (err) {
          if (err instanceof SourceError && err.quota)
            this.quotaUntil.set('hardcover', Date.parse(nextLocalDay()));
        }
        add(before);
        if (this.blocked('hardcover') !== null) break;
      }
    this.lastBatch = report;
    return report;
  }

  // ---- "Refresh due books now" and "Look up all books again" -----------------------------------

  /** Books with at least one due source now, most urgent first. */
  dueItemIds(): string[] {
    return dueItems(loadRefreshRows(this.db, this.sources), this.now()).map((d) => d.itemId);
  }

  refreshDueNow(): LookupStatus {
    if (this.scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
    const ids = this.dueItemIds();
    if (ids.length === 0) throw new HttpError(409, 'No books are due for a refresh.');
    return this.lookups.start({ itemIds: ids, refresh: true, label: 'due' });
  }

  private freshState(): FreshState | null {
    return getSetting<FreshState | null>(this.db, FRESH_KEY, null);
  }

  /** Every book a source can look up, with its sources. */
  private itemSources(): { id: string; sources: SourceName[] }[] {
    return (
      this.db
        .prepare(
          `SELECT i.id, COALESCE(u.kind_override, i.kind) AS kind, i.issue_label FROM items i
           LEFT JOIN user_item u ON u.item_id = i.id`,
        )
        .all() as { id: string; kind: string | null; issue_label: string | null }[]
    )
      .map((r) => ({
        id: r.id,
        sources: this.sources.forItem(r.kind, r.issue_label).map((s) => s.name),
      }))
      .filter((r) => r.sources.length > 0);
  }

  freshEstimate() {
    return freshEstimate(this.itemSources().map((r) => r.sources));
  }

  /**
   * Books "Look up all books again" still has to do: a source not asked since it started, or
   * one that failed since (a used-up daily allowance, or a site that was down).
   */
  freshRemaining(startedAt: string): string[] {
    const state = this.db.prepare(
      'SELECT looked_up_at, outcome FROM lookup_state WHERE item_id = ? AND source = ?',
    );
    return this.itemSources()
      .filter((r) =>
        r.sources.some((s) => {
          const st = state.get(r.id, s) as { looked_up_at: string; outcome: string } | undefined;
          return !st || st.looked_up_at < startedAt || st.outcome === 'failed';
        }),
      )
      .map((r) => r.id);
  }

  async startFresh(
    snapshotDir: string | null,
  ): Promise<{ status: LookupStatus; snapshot: string | null }> {
    if (this.demo) throw new HttpError(409, 'The demo never goes online.');
    if (this.scans.isRunning()) throw new HttpError(409, 'Wait for the scan to finish.');
    if (this.lookups.isRunning()) throw new HttpError(409, 'Lookups are already running.');
    // A copy of the database first, like before a restore, so the old answers can come back.
    const snapshot = snapshotDir
      ? await takeSnapshot(this.db, snapshotDir, 'pre-lookup-again', RESTORE_SNAPSHOTS_KEPT)
      : null;
    if (this.lookups.isRunning()) throw new HttpError(409, 'Lookups are already running.');
    const st: FreshState = {
      startedAt: nowIso(),
      inPass: true,
      passes: 1,
      lastPassDay: null,
      lastRemaining: null,
      snapshot,
    };
    setSetting(this.db, FRESH_KEY, st);
    const status = this.lookups.start({ refresh: true, fresh: true, label: 'fresh' });
    return { status, snapshot };
  }

  private resumeFresh(st: FreshState): void {
    const ids = this.freshRemaining(st.startedAt);
    if (ids.length === 0) {
      setSetting(this.db, FRESH_KEY, null);
      return;
    }
    setSetting(this.db, FRESH_KEY, {
      ...st,
      inPass: true,
      passes: st.inPass ? st.passes : st.passes + 1,
    });
    this.lookups.start({
      itemIds: ids,
      refresh: true,
      fresh: true,
      keepBreakers: true,
      label: 'fresh',
    });
  }

  /** Called when any lookup run ends: keeps "Look up all books again" going, or ends it. */
  private afterRun(s: LookupStatus): void {
    if (s.label !== 'fresh') return;
    const st = this.freshState();
    if (!st) return;
    // Closing the app pauses it; it carries on at the next start.
    if (this.closed) return;
    if (s.status === 'cancelled') {
      setSetting(this.db, FRESH_KEY, null);
      return;
    }
    const remaining = this.freshRemaining(st.startedAt).length;
    // Done, or a pass that got no further (a key that no longer works): stop asking.
    if (remaining === 0 || (st.lastRemaining !== null && remaining >= st.lastRemaining)) {
      setSetting(this.db, FRESH_KEY, null);
      return;
    }
    setSetting(this.db, FRESH_KEY, {
      ...st,
      inPass: false,
      lastPassDay: todayLocal(new Date(this.now())),
      lastRemaining: remaining,
    });
  }

  /** Cancelling a lookup run ends "Look up all books again" too. */
  cancelFresh(): void {
    setSetting(this.db, FRESH_KEY, null);
  }

  // ---- Settings and Diagnostics ---------------------------------------------------------------

  status() {
    const now = this.now();
    const rows = loadRefreshRows(this.db, this.sources);
    const due = rows.filter((r) => {
      const at = dueAt(r);
      return at !== null && at <= now;
    });
    const fresh = this.freshState();
    return {
      enabled: this.enabled(),
      demo: this.demo,
      paused: this.paused,
      running: this.batch !== null,
      lastCheckAt: this.lastCheckAt,
      lastBatch: this.lastBatch,
      dueBooks: new Set(due.map((r) => r.itemId)).size,
      fresh: fresh
        ? {
            startedAt: fresh.startedAt,
            running: this.lookups.isRunning() && fresh.inPass,
            waitingForTomorrow: !fresh.inPass,
            remaining: fresh.lastRemaining,
            passes: fresh.passes,
          }
        : null,
      sources: (['openlibrary', 'anilist', 'hardcover', 'metron', 'comicvine', 'demo'] as const)
        .map((s) => {
          const mine = rows.filter((r) => r.source === s);
          if (mine.length === 0 && this.usageOf(s).today() === 0 && !DAILY_LIMITS[s]) return null;
          if (s !== 'demo' && !this.sources.isConfigured(s) && mine.length === 0) return null;
          if (s === 'demo' && !this.demo) return null;
          const answers = mine.map((r) => r.lastAnswerAt).filter((x): x is string => !!x);
          const limit = DAILY_LIMITS[s];
          return {
            source: s,
            label: SOURCE_LABELS[s],
            books: mine.length,
            due: mine.filter((r) => due.includes(r)).length,
            lastAnswerAt: answers.length ? answers.sort().at(-1)! : null,
            failing: mine.filter((r) => r.failureCount > 0 || r.outcome === 'failed').length,
            automaticToday: this.usageOf(s).today(),
            automaticAllowance: limit ? Math.floor(limit * REFRESH_DAILY_SHARE) : null,
            pausedBecause: this.blocked(s),
          };
        })
        .filter((x) => x !== null),
    };
  }
}
