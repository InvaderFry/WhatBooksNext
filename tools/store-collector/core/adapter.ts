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

export interface ParsedPage {
  records: StoreRecord[];
  excluded: { id: string; reason: ExcludedReason }[];
  /** The next page's cursor, or null when this was the last page. */
  next: string | null;
  /** Field names on the answer's items, for the title-free report (names only, never values). */
  fields: string[];
  /** Labels the store uses for how a book was acquired, counted for the report (never titles). */
  labels: string[];
}

/** The store's page or answer no longer looks like what the adapter knows: stop, never guess. */
export class LayoutChanged extends Error {
  constructor(what: string) {
    super(`The store's library looks different from what this collector knows (${what}).`);
    this.name = 'LayoutChanged';
  }
}
