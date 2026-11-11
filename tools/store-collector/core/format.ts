/**
 * The file a collector downloads and the owner chooses in whatBooksNext (store purchases plan,
 * "1b. JSON format"). The app checks every field again on import; this is the collector's side.
 * Titles stay in this file, which is the owner's own and never goes in the repo.
 */

export const FORMAT = 'whatBooksNext-store-purchases';
export const FORMAT_VERSION = 1;

export type Service = 'kindle' | 'google_play' | 'kobo' | 'globalcomix';

export type Acquisition = 'purchase' | 'free_claim' | 'uncertain';

/** Why something in the store's library isn't a record: it's counted, never imported. */
export type ExcludedReason =
  'sample' | 'subscription' | 'loan' | 'personal_document' | 'upload' | 'other_shelf';

export type CompletionReason =
  | 'finished'
  | 'cancelled'
  | 'signed_out'
  | 'blocked'
  | 'layout_changed'
  | 'limit_reached'
  | 'error';

export interface StoreRecord {
  storeRecordId: string;
  idKind: string;
  title: string;
  creators?: { name: string; role: 'author' | 'writer' | 'artist' | 'unknown' }[];
  kind?: 'book' | 'comic' | 'manga' | 'unknown';
  unit?: 'issue' | 'volume' | 'collection' | 'book';
  series?: string;
  seriesIndex?: string;
  isbn?: string;
  acquisition: { type: Acquisition; evidence: string };
  acquiredAt?: { value: string; precision: 'day' | 'month' | 'year' };
  readingStatus?: 'not_started' | 'in_progress' | 'finished';
  progressPercent?: number;
  readUrl?: string;
  pageUrl?: string;
}

export interface Envelope {
  format: typeof FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  service: Service;
  adapterVersion: string;
  source: { type: 'collector' | 'official_export'; file?: string };
  collectedAt: string;
  region?: string;
  accountScope?: string;
  completion: { status: 'complete' | 'partial' | 'failed'; reason: CompletionReason; text: string };
  counts: {
    seen: number;
    included: number;
    uncertain: number;
    excluded: Partial<Record<ExcludedReason, number>>;
  };
  records: StoreRecord[];
}
