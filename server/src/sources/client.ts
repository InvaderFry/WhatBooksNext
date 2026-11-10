import { CIRCUIT_FAILURES, CIRCUIT_PAUSE_MS, SOURCE_TIMEOUT_MS, USER_AGENT } from '../config.ts';
import type { DB } from '../db/database.ts';
import { nowIso } from '../util.ts';
import { SourceError, type Fetcher, type SourceName } from './types.ts';

/**
 * The polite HTTP side of one source (§12.1): one request at a time, at most one per
 * `minIntervalMs`; obeys Retry-After and rate-limit headers; a raw-response cache; and a
 * circuit breaker that pauses the source after repeated failures, so a site that is down
 * fails soft and isn't hammered (§5). A transient failure never erases good data: callers
 * keep what they had.
 */

export interface SourceStatus {
  source: SourceName;
  state: 'ok' | 'paused';
  consecutiveFailures: number;
  pausedUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  requests: number;
  /** Rate-limit headers from the last response, for Diagnostics. */
  rateLimit: Record<string, string>;
}

export interface ClientOptions {
  name: SourceName;
  minIntervalMs: number;
  db?: DB | null;
  fetcher?: Fetcher;
  /** Injectable clock and sleep, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RATE_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
];

/** Longest we wait on a Retry-After before giving up on this request. */
const MAX_RETRY_WAIT_MS = 120_000;

export class SourceClient {
  readonly name: SourceName;
  private readonly minInterval: number;
  private readonly db: DB | null;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private failures = 0;
  private pausedUntil = 0;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private requests = 0;
  private rateLimit: Record<string, string> = {};

  constructor(o: ClientOptions) {
    this.name = o.name;
    this.minInterval = o.minIntervalMs;
    this.db = o.db ?? null;
    this.fetcher = o.fetcher ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  status(): SourceStatus {
    const paused = this.pausedUntil > this.now();
    return {
      source: this.name,
      state: paused ? 'paused' : 'ok',
      consecutiveFailures: this.failures,
      pausedUntil: paused ? new Date(this.pausedUntil).toISOString() : null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastSuccessAt: this.lastSuccessAt,
      requests: this.requests,
      rateLimit: { ...this.rateLimit },
    };
  }

  /** A fresh start: a new run the owner asked for gets a real try, not a leftover pause. */
  resetBreaker(): void {
    this.failures = 0;
    this.pausedUntil = 0;
  }

  /** A cached response, if any (no request is made). */
  cached(key: string): unknown {
    if (!this.db) return undefined;
    const row = this.db
      .prepare('SELECT payload FROM source_cache WHERE source = ? AND key = ?')
      .pluck()
      .get(this.name, key) as string | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * GET or POST returning JSON. A cached answer is used unless `refresh`; a fresh one replaces
   * the cache only when the request succeeded.
   */
  async json(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
    cacheKey: string | null,
    opts: { refresh?: boolean } = {},
  ): Promise<unknown> {
    if (cacheKey && !opts.refresh) {
      const hit = this.cached(cacheKey);
      if (hit !== undefined) return hit;
    }
    const run = this.queue.then(() => this.request(url, init));
    // The queue continues whatever this request's outcome.
    this.queue = run.catch(() => undefined);
    const payload = await run;
    if (cacheKey && this.db) {
      this.db
        .prepare(
          `INSERT INTO source_cache (source, key, fetched_at, payload) VALUES (?, ?, ?, ?)
           ON CONFLICT (source, key) DO UPDATE SET fetched_at = excluded.fetched_at,
             payload = excluded.payload`,
        )
        .run(this.name, cacheKey, nowIso(), JSON.stringify(payload));
    }
    return payload;
  }

  private async request(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
    retried = false,
  ): Promise<unknown> {
    if (this.pausedUntil > this.now()) {
      throw new SourceError(
        this.name,
        `Paused after ${this.failures} failures in a row; trying again at ${new Date(this.pausedUntil).toLocaleTimeString()}.`,
        true,
      );
    }
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAt = this.now() + this.minInterval;
    this.requests++;

    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: init.method ?? 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      throw this.fail(
        new SourceError(
          this.name,
          e.name === 'TimeoutError' ? 'The request timed out.' : `Couldn't connect (${e.message}).`,
          true,
        ),
      );
    }

    this.rateLimit = {};
    for (const h of RATE_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) this.rateLimit[h] = v;
    }
    const retryAfterMs = retryAfter(res.headers, this.now());
    if (res.headers.get('x-ratelimit-remaining') === '0' && retryAfterMs !== null)
      this.nextAt = Math.max(this.nextAt, this.now() + retryAfterMs);

    if (res.status === 429) {
      const ms = Math.min(retryAfterMs ?? 60_000, MAX_RETRY_WAIT_MS);
      this.nextAt = Math.max(this.nextAt, this.now() + ms);
      if (!retried) return this.request(url, init, true);
      throw this.fail(
        new SourceError(this.name, 'Too many requests; the source asked us to wait.', true),
      );
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      throw this.fail(
        new SourceError(
          this.name,
          `The source refused the request (${res.status}${detail(text)}). Check the API key in Settings.`,
          false,
        ),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw this.fail(
        new SourceError(
          this.name,
          `The source answered ${res.status}${detail(text)}.`,
          res.status >= 500,
        ),
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw this.fail(
        new SourceError(this.name, 'The source sent something that isn’t JSON.', true),
      );
    }
    this.failures = 0;
    this.lastSuccessAt = nowIso();
    return payload;
  }

  private fail(err: SourceError): SourceError {
    this.failures++;
    this.lastError = err.message;
    this.lastErrorAt = nowIso();
    if (this.failures >= CIRCUIT_FAILURES) this.pausedUntil = this.now() + CIRCUIT_PAUSE_MS;
    return err;
  }
}

function detail(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return t ? `: ${t}` : '';
}

/** Retry-After (seconds or a date) or X-RateLimit-Reset (epoch seconds), in ms from now. */
function retryAfter(h: Headers, now: number): number | null {
  const ra = h.get('retry-after');
  if (ra !== null) {
    if (/^\d+$/.test(ra.trim())) return Number(ra) * 1000;
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  const reset = h.get('x-ratelimit-reset');
  if (reset !== null && /^\d+$/.test(reset.trim())) {
    const ms = Number(reset) * 1000 - now;
    if (ms > 0 && ms < 3_600_000) return ms;
  }
  return null;
}
