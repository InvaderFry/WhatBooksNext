/**
 * Everything operating-system specific sits behind this interface (PLAN.md §5, §9.4, §9.5, §14),
 * with a fake for tests and the demo. Passing the fake proves nothing about Windows: the real
 * adapter needs checking on the owner's machine.
 */

export type StorageKind = 'local' | 'external' | 'cloud';

export interface VolumeInfo {
  /** Stable volume identity (Windows: the volume GUID path). Null when the platform has none. */
  volumeId: string | null;
  serial: string | null;
  label: string | null;
  /** Drive letter without the colon, e.g. 'E'. Null when not on a lettered drive. */
  letter: string | null;
  /** Where the volume is mounted now, e.g. 'E:\\' or '/'. */
  root: string;
  /** Path of the folder below `root`, using the platform's separators. */
  relativePath: string;
  storageKind: StorageKind;
  /** Plain-language details for Diagnostics. */
  details: Record<string, string>;
}

/** Windows attribute bits that mark an online-only file (§9.5): RecallOnDataAccess, RecallOnOpen, Offline. */
export const ATTR_RECALL_ON_DATA_ACCESS = 0x00400000;
export const ATTR_RECALL_ON_OPEN = 0x00040000;
export const ATTR_OFFLINE = 0x00001000;
export const PLACEHOLDER_MASK = ATTR_RECALL_ON_DATA_ACCESS | ATTR_RECALL_ON_OPEN | ATTR_OFFLINE;

export type Availability = 'present' | 'placeholder' | 'unknown';

/**
 * Turns raw attributes into availability. `null` means they couldn't be read, which is
 * "unknown" — never "present" (§9.5).
 */
export function availabilityFromAttributes(attrs: number | null | undefined): Availability {
  if (attrs === null || attrs === undefined) return 'unknown';
  return (attrs & PLACEHOLDER_MASK) !== 0 ? 'placeholder' : 'present';
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  /** A symlink or junction: never followed (loop protection, §9.3). */
  isLink: boolean;
  size: number;
  modifiedMs: number | null;
  createdMs: number | null;
  /** Raw Windows attribute bits; null when they couldn't be read. */
  attributes: number | null;
}

export const ATTR_DIRECTORY = 0x10;
export const ATTR_REPARSE_POINT = 0x400;

export interface Platform {
  readonly name: 'windows' | 'generic' | 'fake';

  /** Identity of the volume holding `absPath`, and the path below its root. */
  describeVolume(absPath: string): Promise<VolumeInfo>;

  /** Where a volume is mounted now (Windows: finds it on whichever letter it moved to), or null. */
  findVolumeRoot(volumeId: string): Promise<string | null>;

  /**
   * Lists one directory: names, sizes, dates and (where the platform has them) attributes,
   * all from the directory listing itself — no file is opened, so nothing can be recalled
   * from the cloud. For the light pass's discovery only: it never authorises a content read
   * (§9.5). Throws if the directory can't be listed.
   */
  listDirectory(absDir: string): Promise<DirEntry[]>;
  /** False where we know no placeholder mechanism: files then count as present. */
  readonly supportsPlaceholders: boolean;

  /** Re-check one file immediately before a content read (§9.5). Null if unreadable. */
  checkAttributes(absFile: string): Promise<number | null>;

  /** Opens a file with its default app. Called only with a path from the database (§14). */
  openFile(absFile: string): Promise<void>;
  /** Shows the file selected in the file manager. */
  showInFolder(absFile: string): Promise<void>;

  close(): Promise<void>;
}
