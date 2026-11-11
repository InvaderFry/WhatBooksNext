import { LayoutChanged, type Adapter } from './adapter.ts';
import {
  FORMAT,
  FORMAT_VERSION,
  type CompletionReason,
  type Envelope,
  type ExcludedReason,
  type StoreRecord,
} from './format.ts';
import { MAX_REQUESTS, MAX_STALLED_PAGES, MIN_GAP_MS, PAUSE_EVERY, PAUSE_MS } from './limits.ts';

/**
 * The scan loop every collector shares (store purchases plan, "1a" and "Account safety"):
 * paced requests, deduplication by the store's own ID (every record seen is kept, not only what
 * is on screen at the end), stops at the first warning, never retries, and always ends with a
 * file: complete only when the store's list ended normally.
 */

export interface ScanDeps {
  /** The open tab's address. */
  page: URL;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Waits; rejects (or resolves early) when the signal aborts. */
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

export async function scan(adapter: Adapter, d: ScanDeps): Promise<ScanResult> {
  const lim = {
    minGapMs: MIN_GAP_MS,
    pauseEvery: PAUSE_EVERY,
    pauseMs: PAUSE_MS,
    maxRequests: MAX_REQUESTS,
    maxStalled: MAX_STALLED_PAGES,
    ...d.limits,
  };
  const records = new Map<string, StoreRecord>();
  const excluded = new Map<string, ExcludedReason>();
  const labels: Record<string, number> = {};
  const fields = new Set<string>();
  const errors: string[] = [];
  let requests = 0;
  let fingerprint: ScanResult['stats']['fingerprint'] = 'not reached';
  let reason: CompletionReason = 'finished';
  let text = 'The store’s list ended normally.';
  let region: string | undefined;

  try {
    const where = adapter.checkPage(d.page);
    if (!where.ok) throw new Stop('error', where.message);
    region = where.region;
    const cursors = new Set<string>();
    let cursor: string | null = adapter.firstCursor;
    let stalled = 0;
    while (cursor !== null) {
      if (d.signal.aborted) throw new Stop('cancelled', 'You cancelled the scan.');
      if (requests >= lim.maxRequests)
        throw new Stop(
          'limit_reached',
          `Stopped at the safety limit of ${lim.maxRequests} requests in one scan.`,
        );
      if (requests > 0) {
        const wait = requests % lim.pauseEvery === 0 ? lim.pauseMs : lim.minGapMs;
        d.onProgress?.({ requests, records: records.size, waiting: wait > lim.minGapMs });
        await d.sleep(wait, d.signal);
        if (d.signal.aborted) throw new Stop('cancelled', 'You cancelled the scan.');
      }
      cursors.add(cursor);
      const { url, init } = adapter.request(cursor, d.page);
      requests++;
      const body = await send(d, url, init);
      let page;
      try {
        page = adapter.parse(body);
        fingerprint = 'passed';
      } catch (e) {
        if (e instanceof LayoutChanged) {
          fingerprint = 'failed';
          throw new Stop('layout_changed', e.message);
        }
        throw e;
      }
      for (const f of page.fields) fields.add(f);
      for (const l of page.labels) labels[l] = (labels[l] ?? 0) + 1;
      const before = records.size + excluded.size;
      for (const r of page.records) {
        const key = `${r.idKind}:${r.storeRecordId}`;
        if (!records.has(key) && !excluded.has(key)) records.set(key, r);
      }
      for (const x of page.excluded) {
        const key = `${x.id}`;
        if (!excluded.has(key)) excluded.set(key, x.reason);
      }
      const added = records.size + excluded.size - before;
      d.onProgress?.({ requests, records: records.size, waiting: false });
      if (page.next !== null && cursors.has(page.next))
        throw new Stop('error', 'The store sent the same page twice; stopped instead of looping.');
      stalled = added === 0 && page.next !== null ? stalled + 1 : 0;
      if (stalled >= lim.maxStalled)
        throw new Stop('error', 'The store kept sending no new books; stopped instead of looping.');
      cursor = page.next;
    }
  } catch (e) {
    if (e instanceof Stop) {
      reason = e.reason;
      text = e.message;
    } else {
      reason = 'error';
      text = `Something went wrong: ${(e as Error).message}`;
    }
    errors.push(text);
  }

  const list = [...records.values()];
  const excludedCounts: Partial<Record<ExcludedReason, number>> = {};
  for (const r of excluded.values()) excludedCounts[r] = (excludedCounts[r] ?? 0) + 1;
  const uncertain = list.filter((r) => r.acquisition.type === 'uncertain').length;
  const status =
    reason === 'finished' ? 'complete' : list.length + excluded.size === 0 ? 'failed' : 'partial';
  return {
    envelope: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      service: adapter.service,
      adapterVersion: adapter.version,
      source: { type: 'collector' },
      collectedAt: d.now().toISOString(),
      ...(region ? { region } : {}),
      completion: { status, reason, text },
      counts: {
        seen: list.length + excluded.size,
        included: list.length - uncertain,
        uncertain,
        excluded: excludedCounts,
      },
      records: list,
    },
    stats: { requests, fingerprint, fields: [...fields].sort(), labels, errors },
  };
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
