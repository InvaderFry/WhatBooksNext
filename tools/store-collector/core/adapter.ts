import type { ExcludedReason, Service, StoreRecord } from './format.ts';

/**
 * One store's knowledge: which page it runs on, which read-only library request the page itself
 * makes, how to read one answer, and the layout fingerprint (store purchases plan, "1a"). Pure
 * apart from `request`, which only describes a request: the scan loop sends it.
 */
export interface Adapter {
  service: Service;
  /** Raised whenever reading changes; travels in the file and the report. */
  version: string;
  /** Plain-language name of the store for messages. */
  label: string;
  /** Whether the open tab is the library page; if not, which page to open and how. */
  checkPage(url: URL): { ok: true; region: string } | { ok: false; message: string };
  /** The cursor of the first page of the library. */
  firstCursor: string;
  /** The read-only request for one page of the library (the same one the store's page makes). */
  request(cursor: string, page: URL): { url: string; init: RequestInit };
  /**
   * What the store answers: JSON (default), or an HTML page that the page side turns into plain
   * card objects first (`ScanDeps.fromHtml`), so `parse` stays pure.
   */
  answer?: 'json' | 'html';
  /**
   * A page that brings nothing new means the list has ended (some stores answer a page past the
   * end with the last page again). Otherwise that's a stall, and the scan stops as partial.
   */
  endsWhenNothingNew?: boolean;
  /** Reads one answer. Throws LayoutChanged when something the adapter relies on is missing. */
  parse(body: unknown): ParsedPage;
}

/**
 * A store whose library page shows every book as a card (store purchases plan, Stage 2): the
 * collector scrolls the page and reads the cards, making no requests of its own. `parse` is pure:
 * the page side hands it plain objects it read from the cards.
 */
export interface CardAdapter {
  service: Service;
  version: string;
  label: string;
  checkPage(url: URL): { ok: true; region: string } | { ok: false; message: string };
  /** Reads the cards shown now. `next` is unused. Throws LayoutChanged when they look different. */
  parse(cards: unknown): ParsedPage;
}

/**
 * A store whose service won't answer a script's own request (GlobalComix): the collector makes no
 * requests at all and reads the answers the store's own page receives while the owner browses to
 * the library. `matches` says which answers are the library list.
 */
export interface WatchAdapter {
  service: Service;
  version: string;
  label: string;
  /** Where the owner starts (a page that hasn't loaded the library yet). */
  checkPage(url: URL): { ok: true; region: string } | { ok: false; message: string };
  matches(url: URL): boolean;
  parse(body: unknown): ParsedPage;
}

export interface ParsedPage {
  records: StoreRecord[];
  excluded: { id: string; reason: ExcludedReason }[];
  /** The next page's cursor, or null when this was the last page. */
  next: string | null;
  /** Field names on the answer's items, for the title-free report (names only, never values). */
  fields: string[];
  /** Labels the store uses for how a book was acquired, counted for the report (never titles). */
  labels: string[];
  /**
   * Card adapters read the same card many times while scrolling: each record's label, by
   * `idKind:storeRecordId`, so it's counted once. When given, `labels` is ignored.
   */
  labelFor?: Record<string, string>;
  /** The store's own count of the library, when the page shows one: for the report only. */
  storeTotal?: number;
  /** Which page of the list this answer is (1-based), when the answer says. */
  page?: number;
}

/** The store's page or answer no longer looks like what the adapter knows: stop, never guess. */
export class LayoutChanged extends Error {
  constructor(what: string) {
    super(`The store's library looks different from what this collector knows (${what}).`);
    this.name = 'LayoutChanged';
  }
}
