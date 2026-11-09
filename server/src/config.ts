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
