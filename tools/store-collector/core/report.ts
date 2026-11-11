import type { Adapter } from './adapter.ts';
import type { ScanResult } from './scan.ts';

/**
 * The title-free report the owner pastes into chat (store purchases plan, "1a"): counts, labels
 * and field names only. Never titles, IDs, account names or emails.
 */
export function report(
  adapter: Pick<Adapter, 'label' | 'service' | 'version'>,
  r: ScanResult,
  browser: string,
): string {
  const e = r.envelope;
  const excluded = Object.entries(e.counts.excluded)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
    .join(', ');
  const acquired = {
    purchase: e.records.filter((x) => x.acquisition.type === 'purchase').length,
    free: e.records.filter((x) => x.acquisition.type === 'free_claim').length,
  };
  const has = (k: 'readUrl' | 'pageUrl' | 'isbn' | 'readingStatus' | 'progressPercent') =>
    e.records.filter((x) => x[k] !== undefined).length;
  return [
    'whatBooksNext store collector report (no titles)',
    `Store: ${adapter.label} (${e.region ?? 'region unknown'})`,
    `Collector: ${adapter.service} version ${e.adapterVersion}`,
    `Browser: ${browser}`,
    `Date: ${e.collectedAt}`,
    `Requests: ${r.stats.requests}`,
    `Found: ${e.counts.seen}`,
    `Included: ${e.counts.included} (purchases ${acquired.purchase}, free ${acquired.free})`,
    `Uncertain: ${e.counts.uncertain}`,
    `Excluded: ${excluded || 'none'}`,
    `How acquired (store's labels): ${
      Object.entries(r.stats.labels)
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
    `With a reader link: ${has('readUrl')}, a page link: ${has('pageUrl')}, an ISBN: ${has('isbn')}, progress: ${has('progressPercent')}`,
    `Fields on the store's items: ${r.stats.fields.join(', ') || 'none'}`,
    `Completeness: ${e.completion.status} (${e.completion.reason}): ${e.completion.text}`,
    `Layout check: ${r.stats.fingerprint}`,
    `Errors: ${r.stats.errors.length ? r.stats.errors.join(' | ') : 'none'}`,
  ].join('\n');
}
