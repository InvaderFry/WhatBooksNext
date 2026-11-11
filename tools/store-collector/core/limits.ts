/**
 * Account safety limits for every collector (store purchases plan, "Account safety"; PLAN.md
 * §20 assumptions). They keep a scan close to the owner scrolling their own library. Change them
 * only with a reason, here and in PLAN.md §20.
 */

/** At least this long between two page loads or library requests: about a person's pace. */
export const MIN_GAP_MS = 2_000;

/** After this many requests, a longer pause, so a long library isn't read in one burst. */
export const PAUSE_EVERY = 50;

/** The longer pause. */
export const PAUSE_MS = 30_000;

/**
 * At most this many requests in one scan. At 50 books a request that is 15,000 books, far more
 * than a personal library; hitting it stops the scan as partial ("limit_reached").
 */
export const MAX_REQUESTS = 300;

/**
 * Pages in a row that bring no new book while the store says there are more: the list has stalled
 * (or is repeating itself), so the scan stops as partial instead of looping.
 */
export const MAX_STALLED_PAGES = 2;
