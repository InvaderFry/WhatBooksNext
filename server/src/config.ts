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
