/**
 * Invented store purchases files for tests and the demo (store purchases plan, "1b"). IDs start
 * with INVENTED, which no store uses, so none can point to a real book.
 */

export interface InventedRecord {
  id: string;
  title: string;
  author?: string;
  acquisition?: 'purchase' | 'free_claim' | 'uncertain';
  isbn?: string;
  readUrl?: string;
  readingStatus?: 'not_started' | 'in_progress' | 'finished';
  unit?: string;
}

export function storeFile(records: InventedRecord[], over: Record<string, unknown> = {}): string {
  const recs = records.map((r) => ({
    storeRecordId: r.id,
    idKind: 'asin',
    title: r.title,
    ...(r.author ? { creators: [{ name: r.author, role: 'author' }] } : {}),
    unit: r.unit ?? 'book',
    ...(r.isbn ? { isbn: r.isbn } : {}),
    acquisition: { type: r.acquisition ?? 'purchase', evidence: 'originType PURCHASE' },
    ...(r.readingStatus ? { readingStatus: r.readingStatus } : {}),
    ...(r.readUrl ? { readUrl: r.readUrl } : {}),
  }));
  const uncertain = recs.filter((r) => r.acquisition.type === 'uncertain').length;
  return JSON.stringify({
    format: 'whatBooksNext-store-purchases',
    formatVersion: 1,
    service: 'kindle',
    adapterVersion: '1',
    source: { type: 'collector' },
    collectedAt: '2026-11-11T12:00:00.000Z',
    region: 'read.amazon.com',
    completion: {
      status: 'complete',
      reason: 'finished',
      text: 'The store’s list ended normally.',
    },
    counts: {
      seen: recs.length + 2,
      included: recs.length - uncertain,
      uncertain,
      excluded: { sample: 1, subscription: 1 },
    },
    records: recs,
    ...over,
  });
}
