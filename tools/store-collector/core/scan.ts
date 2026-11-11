import { LayoutChanged, type Adapter, type CardAdapter, type ParsedPage } from './adapter.ts';
import {
  FORMAT,
  FORMAT_VERSION,
  type CompletionReason,
  type Envelope,
  type ExcludedReason,
  type Service,
  type StoreRecord,
} from './format.ts';
import { MAX_REQUESTS, MAX_STALLED_PAGES, MIN_GAP_MS, PAUSE_EVERY, PAUSE_MS } from './limits.ts';

/**
 * The scan loops every collector shares (store purchases plan, "1a" and "Account safety"):
 * paced steps, deduplication by the store's own ID (every record seen is kept, not only what is
 * on screen at the end), stops at the first warning, never retries, and always ends with a file:
 * complete only when the store's list ended normally.
 *
 * - `scan`: the store's page asks its server for the library a page at a time; the collector makes
 *   the same read-only requests (Kindle).
 * - `scanCards`: the store's page already shows every book as a card; the collector scrolls and
 *   reads the cards, making no requests at all (Google Play Books).
 */

interface CommonDeps {
  /** The open tab's address when the scan starts. */
  page: URL;
  /** Waits; resolves early when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  signal: AbortSignal;
  onProgress?: (p: { requests: number; records: number; waiting: boolean }) => void;
  limits?: Partial<{
    minGapMs: number;
    pauseEvery: number;
    pauseMs: number;
    maxRequests: number;
    maxStalled: number;
  }>;
}

export interface ScanDeps extends CommonDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface CardScanDeps extends CommonDeps {
  /** The tab's address now: a sign-in page or another page stops the scan. */
  currentUrl: () => URL;
  /** The cards on the page now, as plain objects for the adapter. */
  readCards: () => unknown;
  /** Scrolls on by about a screen; says whether the list is at its end. */
  scroll: () => { atBottom: boolean };
}

export interface ScanResult {
  envelope: Envelope;
  /** For the title-free report. */
  stats: {
    requests: number;
    fingerprint: 'passed' | 'failed' | 'not reached';
    fields: string[];
    labels: Record<string, number>;
    errors: string[];
  };
}

class Stop extends Error {
  reason: CompletionReason;
  constructor(reason: CompletionReason, text: string) {
    super(text);
    this.reason = reason;
  }
}

/** What a scan has found so far, and the file and stats it ends with. */
class Collected {
  records = new Map<string, StoreRecord>();
  excluded = new Map<string, ExcludedReason>();
  labels: Record<string, number> = {};
  fields = new Set<string>();
  errors: string[] = [];
  steps = 0;
  fingerprint: ScanResult['stats']['fingerprint'] = 'not reached';
  reason: CompletionReason = 'finished';
  text = 'The store’s list ended normally.';
  region: string | undefined;

  /** Reads one answer or one look at the page; returns how many new books it brought. */
  read(parse: () => ParsedPage): ParsedPage & { added: number } {
    let page: ParsedPage;
    try {
      page = parse();
      this.fingerprint = 'passed';
    } catch (e) {
      if (e instanceof LayoutChanged) {
        this.fingerprint = 'failed';
        throw new Stop('layout_changed', e.message);
      }
      throw e;
    }
    for (const f of page.fields) this.fields.add(f);
    for (const l of page.labels) this.labels[l] = (this.labels[l] ?? 0) + 1;
    const before = this.records.size + this.excluded.size;
    for (const r of page.records) {
      const key = `${r.idKind}:${r.storeRecordId}`;
      if (!this.records.has(key) && !this.excluded.has(key)) this.records.set(key, r);
    }
    for (const x of page.excluded) if (!this.excluded.has(x.id)) this.excluded.set(x.id, x.reason);
    return { ...page, added: this.records.size + this.excluded.size - before };
  }

  stop(e: unknown): void {
    if (e instanceof Stop) {
      this.reason = e.reason;
      this.text = e.message;
    } else {
      this.reason = 'error';
      this.text = `Something went wrong: ${(e as Error).message}`;
    }
    this.errors.push(this.text);
  }

  result(adapter: { service: Service; version: string }, now: Date): ScanResult {
    const list = [...this.records.values()];
    const excludedCounts: Partial<Record<ExcludedReason, number>> = {};
    for (const r of this.excluded.values()) excludedCounts[r] = (excludedCounts[r] ?? 0) + 1;
    const uncertain = list.filter((r) => r.acquisition.type === 'uncertain').length;
    const status =
      this.reason === 'finished'
        ? 'complete'
        : list.length + this.excluded.size === 0
          ? 'failed'
          : 'partial';
    return {
      envelope: {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        service: adapter.service,
        adapterVersion: adapter.version,
        source: { type: 'collector' },
        collectedAt: now.toISOString(),
        ...(this.region ? { region: this.region } : {}),
        completion: { status, reason: this.reason, text: this.text },
        counts: {
          seen: list.length + this.excluded.size,
          included: list.length - uncertain,
          uncertain,
          excluded: excludedCounts,
        },
        records: list,
      },
      stats: {
        requests: this.steps,
        fingerprint: this.fingerprint,
        fields: [...this.fields].sort(),
        labels: this.labels,
        errors: this.errors,
      },
    };
  }
}

const limitsOf = (d: CommonDeps) => ({
  minGapMs: MIN_GAP_MS,
  pauseEvery: PAUSE_EVERY,
  pauseMs: PAUSE_MS,
  maxRequests: MAX_REQUESTS,
  maxStalled: MAX_STALLED_PAGES,
  ...d.limits,
});

/** Before every step but the first: the usual gap, or the longer pause; and the cancel check. */
async function pace(c: Collected, d: CommonDeps, lim: ReturnType<typeof limitsOf>) {
  if (d.signal.aborted) throw new Stop('cancelled', 'You cancelled the scan.');
  if (c.steps >= lim.maxRequests)
    throw new Stop(
      'limit_reached',
      `Stopped at the safety limit of ${lim.maxRequests} steps in one scan.`,
    );
  if (c.steps > 0) {
    const wait = c.steps % lim.pauseEvery === 0 ? lim.pauseMs : lim.minGapMs;
    d.onProgress?.({ requests: c.steps, records: c.records.size, waiting: wait > lim.minGapMs });
    await d.sleep(wait, d.signal);
    if (d.signal.aborted) throw new Stop('cancelled', 'You cancelled the scan.');
  }
}

export async function scan(adapter: Adapter, d: ScanDeps): Promise<ScanResult> {
  const lim = limitsOf(d);
  const c = new Collected();
  try {
    const where = adapter.checkPage(d.page);
    if (!where.ok) throw new Stop('error', where.message);
    c.region = where.region;
    const cursors = new Set<string>();
    let cursor: string | null = adapter.firstCursor;
    let stalled = 0;
    while (cursor !== null) {
      await pace(c, d, lim);
      cursors.add(cursor);
      const { url, init } = adapter.request(cursor, d.page);
      c.steps++;
      const body = await send(d, url, init);
      const page = c.read(() => adapter.parse(body));
      d.onProgress?.({ requests: c.steps, records: c.records.size, waiting: false });
      if (page.next !== null && cursors.has(page.next))
        throw new Stop('error', 'The store sent the same page twice; stopped instead of looping.');
      stalled = page.added === 0 && page.next !== null ? stalled + 1 : 0;
      if (stalled >= lim.maxStalled)
        throw new Stop('error', 'The store kept sending no new books; stopped instead of looping.');
      cursor = page.next;
    }
  } catch (e) {
    c.stop(e);
  }
  return c.result(adapter, d.now());
}

/**
 * Scrolls the library and reads its cards, keeping every card seen (a list may drop cards that
 * scrolled off screen). Complete when the end of the list brings nothing new twice running.
 */
export async function scanCards(adapter: CardAdapter, d: CardScanDeps): Promise<ScanResult> {
  const lim = limitsOf(d);
  const c = new Collected();
  try {
    const where = adapter.checkPage(d.page);
    if (!where.ok) throw new Stop('error', where.message);
    c.region = where.region;
    let idleAtEnd = 0;
    for (;;) {
      await pace(c, d, lim);
      const here = d.currentUrl();
      if (here.host !== d.page.host || here.pathname !== d.page.pathname)
        throw /signin|login|accounts\./i.test(here.href)
          ? new Stop('signed_out', 'The store asked you to sign in. Sign in, then run it again.')
          : new Stop(
              'blocked',
              'The tab went to another page during the scan. Stopped; open the library again.',
            );
      c.steps++;
      const cards = d.readCards();
      const page = c.read(() => adapter.parse(cards));
      // An empty list never counts as an empty library: the page probably looks different.
      if (c.steps === 1 && c.records.size + c.excluded.size === 0) {
        c.fingerprint = 'failed';
        throw new Stop(
          'layout_changed',
          'No book cards were found on the page. If your library isn’t empty, the store’s page has changed.',
        );
      }
      d.onProgress?.({ requests: c.steps, records: c.records.size, waiting: false });
      const { atBottom } = d.scroll();
      idleAtEnd = atBottom && page.added === 0 ? idleAtEnd + 1 : 0;
      if (idleAtEnd >= lim.maxStalled) break;
    }
  } catch (e) {
    c.stop(e);
  }
  return c.result(adapter, d.now());
}

/**
 * Sends one request in the owner's own signed-in tab. Stops at the first sign of trouble: a
 * sign-in page, 401/403/429, an unexpected redirect, or an answer that isn't the library's.
 */
async function send(d: ScanDeps, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await d.fetch(url, { credentials: 'include', ...init, signal: d.signal });
  } catch (e) {
    if (d.signal.aborted) throw new Stop('cancelled', 'You cancelled the scan.');
    throw new Stop('error', `The request failed: ${(e as Error).message}`);
  }
  const final = res.url ? new URL(res.url) : new URL(url);
  if (/\/ap\/(signin|mfa|cvf)|signin|login/i.test(final.pathname))
    throw new Stop('signed_out', 'The store asked you to sign in. Sign in, then run it again.');
  if (res.status === 401)
    throw new Stop('signed_out', 'The store says you’re signed out. Sign in, then run it again.');
  if (res.status === 403 || res.status === 429)
    throw new Stop(
      'blocked',
      `The store refused the request (HTTP ${res.status}). Stopped; don’t run it again today.`,
    );
  if (res.redirected && final.host !== new URL(url).host)
    throw new Stop('blocked', `The store sent the request somewhere else (${final.host}).`);
  if (!res.ok) throw new Stop('error', `The store answered HTTP ${res.status}.`);
  if (!/json/i.test(res.headers.get('content-type') ?? ''))
    throw new Stop(
      'blocked',
      'The store answered with a page instead of the library list (maybe a check that you’re a person). Stopped.',
    );
  try {
    return await res.json();
  } catch {
    throw new Stop('layout_changed', 'The store’s answer couldn’t be read.');
  }
}
