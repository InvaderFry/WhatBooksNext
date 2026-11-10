// Starting values from PLAN.md §20. Every number here is an assumption with a reason,
// to be tuned against fixtures and real use. Keep them in this one module.

/** Default port: unlikely to clash with common dev tools (§20). Overridable with PORT. */
export const DEFAULT_PORT = 4818;

/** Vite's dev server port. Allowed as a Host/Origin only in development (§6.3). */
export const DEV_WEB_PORT = 5173;

/** Pre-migration snapshots kept: a few versions back without filling the disk (§20). */
export const MIGRATION_SNAPSHOTS_KEPT = 5;

/** Pre-restore snapshots kept, separately, so neither kind pushes the other out (§16, §20). */
export const RESTORE_SNAPSHOTS_KEPT = 3;

/** Scan reminder after this many days without a complete scan, as the owner asked (§9.7). */
export const SCAN_REMINDER_DAYS = 30;

/**
 * Directory nesting limit while scanning. Junctions and symlinks are skipped already (§9.3);
 * this stops a loop we failed to recognise. The M0 probe used the same limit.
 */
export const MAX_SCAN_DEPTH = 64;

/** Formats read in the deep pass (§9.1). */
export const DEEP_FORMATS = ['epub', 'pdf', 'cbz', 'cbr'] as const;

/** Formats listed and parsed by filename only (§9.1). */
export const LIGHT_FORMATS = ['mobi', 'azw3', 'cb7'] as const;

/**
 * File extension → format. .zip and .rar are comic archives: the owner confirmed theirs are
 * comics (PLAN.md §9.1, after M0). The M2 deep pass checks they really hold page images.
 */
export const EXTENSION_FORMATS: Readonly<Record<string, string>> = {
  epub: 'epub',
  pdf: 'pdf',
  cbz: 'cbz',
  zip: 'cbz',
  cbr: 'cbr',
  rar: 'cbr',
  mobi: 'mobi',
  azw3: 'azw3',
  cb7: 'cb7',
};

/** Largest JSON body accepted (a backup restore). A big library's backup is a few MB. */
export const MAX_JSON_BODY = '100mb';

// ---- Deep pass (M2, PLAN.md §6.1, §9.2, §20) ------------------------------------------------------

/**
 * Worker pool size: CPU cores − 1, at most 4 (§20). Keeps the PC usable during a deep scan.
 * Never fewer than 1.
 */
export const MAX_WORKERS = 4;

/** Each worker's JavaScript heap cap (§20). Large PDFs need headroom; this doesn't cap native memory. */
export const WORKER_HEAP_MB = 1024;

/** Per-file time limit for parsing, counting and thumbnails — not full hashing (§20). */
export const FILE_TIME_LIMIT_MS = 60_000;

/** Largest total uncompressed size of an archive's entries (§20): big comics are fine, zip bombs aren't. */
export const MAX_UNCOMPRESSED_BYTES = 4 * 1024 ** 3;

/** Largest compression ratio, per entry and overall (§20). Real comics and EPUBs are far below it. */
export const MAX_COMPRESSION_RATIO = 100;

/** Largest image decoded, in pixels (§20). Checked from the image header, before decoding. */
export const MAX_IMAGE_PIXELS = 50_000_000;

/**
 * Largest RAR read. The RAR reader (WASM) needs the whole archive in memory, so a limit stops a
 * few huge CBRs at once from exhausting the PC (§6.1). Assumption: the owner's comic archives are
 * 30–250 MB (M1 scan sizes); anything bigger is reported in Library health instead.
 */
export const MAX_RAR_BYTES = 1024 ** 3;

/**
 * Files at least this big count as "large": only one large file is read at a time across the
 * whole pool (§6.1 "one large file per worker at a time", tightened to one overall because the
 * RAR and PDF readers keep the file in memory). Assumption, tune with real drives.
 */
export const LARGE_FILE_BYTES = 256 * 1024 ** 2;

/** Partial hash: SHA-256 of the first and last 64 KB, plus the size (§20). */
export const PARTIAL_HASH_CHUNK = 64 * 1024;

/** Thumbnails: the longest side in pixels. Small enough for a few thousand covers to stay light. */
export const THUMBNAIL_MAX_SIDE = 320;

/** JPEG quality for thumbnails. Covers are viewed small; 80 looks clean at a fraction of the size. */
export const THUMBNAIL_QUALITY = 80;

/**
 * PDF type sampling (§10): this many pages, spread through the document. Enough to see whether
 * it is mostly page-sized images or mostly text without reading a whole 900-page book.
 */
export const PDF_TYPE_SAMPLE_PAGES = 8;

/** ISBN candidates are read from the first pages of a PDF only (§10: "the first ~10 pages"). */
export const PDF_ISBN_PAGES = 10;

/**
 * A page counts as "text" with at least this many characters of text layer. A line of 60–80
 * characters; less is page numbers, credits or a caption.
 */
export const PDF_TEXT_PAGE_CHARS = 200;

/** An image covering at least this share of a page counts as a full-page image (allowing margins). */
export const PDF_FULL_PAGE_IMAGE = 0.85;

/** Share of sampled pages that must agree before a type is decided; otherwise "uncertain" (§10). */
export const PDF_TYPE_MAJORITY = 0.7;

/**
 * Portrait comic shape: page height ÷ width. US comics are about 1.54, manga about 1.42, European
 * albums about 1.33. Wider or much taller pages aren't comic pages.
 */
export const COMIC_ASPECT_MIN = 1.25;
export const COMIC_ASPECT_MAX = 1.75;

/**
 * An archive is a comic when at least this share of its entries (ignoring known sidecar files) are
 * images, with at least 2 images (§9.1).
 */
export const COMIC_ARCHIVE_IMAGE_SHARE = 0.8;

/** Scan reminder snooze when the banner is dismissed (§9.7, §20). */
export const SCAN_REMINDER_SNOOZE_DAYS = 7;

/** Show a time estimate only after this many files were read in this run (§9.6). */
export const ESTIMATE_AFTER_FILES = 20;

/**
 * Cross-folder suggestions (§11.3 rule 3) need a base name at least this long. Two "1.pdf"s or
 * "book.epub"s in different folders say nothing about being the same work.
 */
export const MIN_SUGGESTION_KEY_LENGTH = 6;

/**
 * Full hashes run one file at a time, last (§9.2, §20 "low priority"). Hashing is reading, and
 * a spinning USB drive reads fastest sequentially; one stream also leaves the PC responsive.
 */
export const FULL_HASH_CONCURRENCY = 1;

/**
 * PDFs are read in ranges of this size, straight from the file, never whole. pdf.js visits every
 * page object when it opens a file, one range each, so this sets the cost of opening: 64 KB × a
 * 200-page comic ≈ 13 MB instead of the whole file. Text pages' content usually fits in one.
 */
export const PDF_RANGE_CHUNK = 64 * 1024;

/**
 * Files read at once from an external drive. The owner's first scan was disk-bound (USB hard
 * drive 100% busy, CPU about 2%), and several readers at once make a spinning drive seek
 * between files. Internal drives (usually SSDs) use the whole pool. Assumption, measure on the
 * owner's drive.
 */
export const EXTERNAL_READ_CONCURRENCY = 1;

// ---- Lookups (M3, PLAN.md §12) ---------------------------------------------------------------

/**
 * Identifies the app to online sources. Open Library asks for the app's name and a contact
 * (verified November 2026); the project page is the contact, never the owner's email (§5).
 */
export const USER_AGENT =
  'whatBooksNext/0.3 (personal reading tool; github.com/InvaderFry/whatBooksNext)';

/**
 * Open Library: 1 request per second for requests without a contact email, 3 with one
 * (openlibrary.org/developers/api, verified November 2026). We send no email, so 1 per second.
 */
export const OPENLIBRARY_MIN_INTERVAL_MS = 1000;

/**
 * AniList: 90 requests a minute nominally, 30 while degraded; the live API answered with
 * X-RateLimit-Limit: 30 in November 2026. One request every 2.1 s stays under 30 a minute, and
 * the client also obeys X-RateLimit-Remaining and Retry-After.
 */
export const ANILIST_MIN_INTERVAL_MS = 2100;

/**
 * Hardcover: free tokens get 60 requests a minute, a burst of 10 and 5,000 a day
 * (hardcover-docs Getting-Started, verified November 2026). One a second, one top-level field
 * per request, so a 4,000-book library fits in one day's allowance.
 */
export const HARDCOVER_MIN_INTERVAL_MS = 1000;

/** Hardcover's daily allowance on a free token; lookups stop for the day before reaching it. */
export const HARDCOVER_DAILY_LIMIT = 5000;

/**
 * Metron (comics): a burst limit of at least 20 requests a minute and 5,000 a day for a free
 * account, reported in X-RateLimit-Burst-* and X-RateLimit-Sustained-* headers (Metron's own
 * client library, Mokkari 5.0, November 2026; metron.cloud's docs refuse automated reads). One
 * request every 3.1 s stays under 20 a minute.
 */
export const METRON_MIN_INTERVAL_MS = 3100;

/** Metron's daily allowance on a free account; lookups stop for the day a little before it. */
export const METRON_DAILY_LIMIT = 5000;

/**
 * ComicVine: "200 requests per resource, per hour", with blocks for too many a second
 * (comicvine.gamespot.com/api, November 2026). One request every 18.5 s stays under 200 an
 * hour even when every request hits the same resource. It's the fallback, asked only when
 * Metron finds nothing, so this slowness costs little.
 */
export const COMICVINE_MIN_INTERVAL_MS = 18_500;

/** Give up on one request after this long. Hardcover's own limit is 30 s (2 s for search). */
export const SOURCE_TIMEOUT_MS = 20_000;

/**
 * Circuit breaker: after this many failures in a row a source is paused (§5 "flaky sources
 * fail soft"), so a site that is down isn't hammered and the rest of the lookup carries on.
 */
export const CIRCUIT_FAILURES = 5;

/** How long a tripped source stays paused before one trial request. */
export const CIRCUIT_PAUSE_MS = 10 * 60_000;

/**
 * A lookup run stops after this many books in a row couldn't reach any of their sources:
 * the connection is down (Wi-Fi, a VPN switching over), and carrying on would only mark the
 * rest of the library "failed". The next run carries on where it stopped.
 */
export const LOOKUP_STOP_AFTER_FAILED_ITEMS = 10;

/** Search results considered per source. More rarely helps and costs rate limit. */
export const SEARCH_RESULTS = 5;

/** Match thresholds (§11.2, §20): cautious, because a wrong match hurts more than none. */
export const MATCH_ACCEPT = 0.9;
export const MATCH_REVIEW = 0.6;

/** Two candidates closer than this are a tie: neither is accepted (§11.2, §20). */
export const MATCH_TIE_MARGIN = 0.05;

// ---- Estimates (§12.3, §20) ------------------------------------------------------------------

/** Brysbaert (2019) meta-analysis of adult silent reading: ~260 wpm fiction, ~238 nonfiction. */
export const WPM_FICTION = 260;
export const WPM_NONFICTION = 238;
/** Assumption: code, diagrams and rereading slow technical reading a lot. */
export const WPM_TECH = 150;
/** Assumption; calibrate. */
export const COMIC_SECONDS_PER_PAGE = 20;
/** Assumption: fewer words per page than Western comics; calibrate. */
export const MANGA_SECONDS_PER_PAGE = 10;
/** Assumption: a typical trade paperback page. Marks the estimate rough. */
export const WORDS_PER_PAGE = 275;
/** Assumption: speed varies by book and mood, so a ±20% range, never a measured confidence. */
export const ESTIMATE_SPREAD = 0.2;

/** "An evening" and "a weekend" (§13.2, §20). Shown in the UI. */
export const EVENING_MINUTES = 3 * 60;
export const WEEKEND_MINUTES = 10 * 60;

// ---- Ranking (§12.2, §13.7, §20) -------------------------------------------------------------

/** Ratings lead; recency stays a nudge (§20). Adjustable under Tune (M5). */
export const WEIGHTS = {
  rating: 0.35,
  timeFit: 0.2,
  taste: 0.15,
  momentum: 0.15,
  triage: 0.1,
  recency: 0.05,
} as const;

/**
 * "Highly rated": at or above this percentile of one source's shrunk scores in this library;
 * with fewer than HIGHLY_RATED_MIN_ITEMS rated items from that source, ≥ 80 / 100 instead.
 * Star averages cluster near 4 / 5, so a fixed cut-off would pass most books from one source.
 */
export const HIGHLY_RATED_PERCENTILE = 0.7;
export const HIGHLY_RATED_MIN_ITEMS = 30;
export const HIGHLY_RATED_FALLBACK = 80;

/** Read next shows this many cards; "Show more" adds as many again (§20). */
export const READ_NEXT_PAGE = 10;

/** Recency boost: acquired within this many days (§13.7, §20). */
export const RECENT_DAYS = 60;

/** A library folder where over this share of files share one day's date is a bulk copy (§20). */
export const BULK_COPY_SHARE = 0.5;

/** The first triage session's length (§20): enough to help, short enough to finish. */
export const TRIAGE_SESSION = 15;

/** "Defer" in Needs review hides a row for this long unless the owner picks a date. */
export const REVIEW_DEFER_DAYS = 30;

/**
 * A PDF with at least PICTURE_MIN_PAGES pages and fewer than PICTURE_WORDS_PER_PAGE words a page
 * is mostly pictures: its length comes from its pages, and its kind is guessed as comic. Prose
 * runs to 250–400 words a page; a comic's text layer (balloons, credits, captions) stays below 150.
 * From the owner's first quality check: a comic PDF read as "~5 min from 741 words", and comics
 * with lettered speech balloons came to about 60 words a page, and wordy ones over 100, so the
 * line is at 150, still below prose. (Sparse poetry could fall under it; the owner's kind
 * correction then wins.)
 */
export const PICTURE_MIN_PAGES = 20;
export const PICTURE_WORDS_PER_PAGE = 150;

/**
 * Author variety in Read next: each earlier card in the list that shares an author lowers a card's
 * score by this much. A bundle of one author's books downloaded on one day otherwise filled five
 * of the top seven (owner's first quality check). Small, so a clearly better book still leads.
 */
export const SAME_AUTHOR_PENALTY = 0.04;

/** Undo stack: the last 20 merges and splits (§20 "covers a cleanup session"). */
export const UNDO_STACK_SIZE = 20;

/** Assumption: bound catalogue responses below Hardcover's documented 997-row relation limit. */
export const SERIES_PUBLICATION_LIMIT = 500;
// Refuse a truncated membership list instead of choosing an unverified series.
export const SERIES_MEMBERSHIP_LIMIT = 100;
/** Assumption: weekly catalogue refresh catches new volumes without repeated requests per book. */
export const SERIES_PUBLICATION_CACHE_DAYS = 7;

// ---- Modes and taste (M5, PLAN.md §13.10, §13.11, §20) -------------------------------------

/** Hidden gems: votes in the bottom 25% for that source, and at least 5 votes (§20). */
export const HIDDEN_GEM_VOTE_PERCENTILE = 0.25;
export const HIDDEN_GEM_MIN_VOTES = 5;

/** Classics you missed: first published at least 25 years ago (§20). */
export const CLASSICS_AGE_YEARS = 25;

/** One-sitting reads: the default Finish-within budget, a typical uninterrupted session (§20). */
export const ONE_SITTING_MINUTES = 120;

/** Surprise me: random from the top 50 of Read next, probability ∝ score² (§20). */
export const SURPRISE_POOL = 50;

/**
 * Mood re-weights rather than filters (§13.10): an item that fits the mood gains up to this much
 * score. Assumption: about the size of the rating's spread between an average and a highly
 * rated book, so the mood leads without hiding everything else.
 */
export const MOOD_WEIGHT = 0.3;

/**
 * Skim: "short items" are those whose whole length is at most this long. Assumption: an hour is
 * a skim; anything longer is a read.
 */
export const SKIM_MINUTES = 60;

/**
 * Taste is inert below 10 explicit outcomes (rated, finished, or DNF "Not for me"), counted after
 * the series cap, from at least 3 different authors or series (§20).
 */
export const TASTE_THRESHOLD = 10;
export const TASTE_MIN_GROUPS = 3;

/** A series counts as at most 2 items of evidence (§20), so one long run can't dominate. */
export const TASTE_SERIES_CAP = 2;

/**
 * Evidence strength (§13.11): your rating > finished (engagement, not necessarily enjoyment) >
 * imported history. Assumption: each step about half the one before.
 */
export const TASTE_EVIDENCE = { rated: 1, finished: 0.6, notForMe: 1, importedFactor: 0.5 };

/**
 * A signal is shrunk toward the owner's own average with this much pretend evidence, so one book
 * doesn't make a genre a favourite. Assumption: two books' worth.
 */
export const TASTE_PRIOR_WEIGHT = 2;

/** A signal needs at least this much evidence (in books) before it counts at all. Assumption. */
export const TASTE_MIN_SIGNAL = 1;

/** A signal is given as a reason only when it stands out by at least this much. Assumption. */
export const TASTE_REASON_MIN = 0.15;

/** Off / Low / Normal / High (§13.11): how strongly learned taste moves the taste component. */
export const TASTE_STRENGTH = { off: 0, low: 0.5, normal: 1, high: 2 } as const;

/** Still reading? after 90 untouched days in progress; Snooze lasts 30 days (§20). */
export const STILL_READING_DAYS = 90;
export const STILL_READING_SNOOZE_DAYS = 30;

/** Topic interests: at most this many, each at most this long. Enough for real interests. */
export const MAX_TOPICS = 30;
export const MAX_TOPIC_LENGTH = 40;

/**
 * Taste reasons say "You rate X highly" only when the owner's own ratings behind X average at
 * least this; otherwise "above your other books". Assumption: 8/10 is a rating most people would
 * call high; a strict rater's 6s and 7s can stand out without being high.
 */
export const TASTE_HIGH_RATING = 8;
