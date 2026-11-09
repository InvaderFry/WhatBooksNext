// Thin fetch wrapper. Every request that changes data is sent as JSON, which the server
// requires: it makes the browser preflight any cross-site attempt (PLAN.md §6.3).

export class ApiError extends Error {
  readonly status: number;
  readonly needsConfirmation: boolean;
  constructor(status: number, message: string, needsConfirmation = false) {
    super(message);
    this.status = status;
    this.needsConfirmation = needsConfirmation;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; needsConfirmation?: boolean };
    throw new ApiError(
      res.status,
      d.error ?? `Request failed (${res.status}).`,
      Boolean(d.needsConfirmation),
    );
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  delete: <T>(url: string) => call<T>('DELETE', url),
};

// ---- Shapes returned by the server ----------------------------------------------------------

export interface Availability {
  state: 'present' | 'not_connected' | 'online_only' | 'unknown' | 'missing' | 'store' | 'none';
  label: string | null;
  alsoInICloud: boolean;
  readyToRead: boolean;
}

export interface UserData {
  progress: Progress;
  dnfReason: DnfReason | null;
  startedOn: string | null;
  startedPrecision: Precision | null;
  finishedOn: string | null;
  finishedPrecision: Precision | null;
  progressAt: string | null;
  rating: number | null;
  note: string | null;
  takeaway: string | null;
  hidden: boolean;
  shortlistPosition: number | null;
  titleOverride: string | null;
  kindOverride: Kind | null;
  referenceOverride: boolean | null;
  icloudOverride: 'in' | 'not_in' | null;
}

export interface ItemSummary {
  id: string;
  title: string;
  factTitle: string;
  kind: Kind | null;
  kindIsGuess: boolean;
  isReference: boolean;
  seriesHint: string | null;
  formats: string[];
  fileCount: number;
  folderIds: string[];
  availability: Availability;
  user: UserData;
  firstSeenAt: string;
}

export interface FileDetail {
  id: string;
  name: string;
  relPath: string;
  folderId: string;
  folderPath: string;
  folderReachable: boolean;
  format: string;
  size: number;
  availability: string;
  stale: boolean;
  isPrimary: boolean;
  qualityTag: string | null;
  editionNumber: number | null;
  editionNote: string | null;
  language: string | null;
  modifiedMs: number | null;
  firstSeenAt: string;
}

export interface ItemDetail extends ItemSummary {
  files: FileDetail[];
  parse: Record<string, unknown> | null;
  redirectedFrom?: string;
}

export interface Folder {
  id: string;
  displayPath: string;
  volumeLabel: string | null;
  lastLetter: string | null;
  storageKind: 'local' | 'external' | 'cloud';
  alsoInICloud: boolean;
  reachable: boolean;
  lastSeenAt: string | null;
  lastCompleteScanAt: string | null;
  scanOverdue: boolean;
  files: Record<string, number>;
  staleFiles: number;
}

export interface FolderScan {
  folderId: string;
  displayPath: string;
  status: 'completed' | 'partial' | 'cancelled' | 'unreachable';
  dirsListed: number;
  dirErrors: number;
  linksSkipped: number;
  filesSeen: number;
  newFiles: number;
  missing: number;
  stale: number;
  returned: number;
  ignoredByType: Record<string, number>;
}

export interface ScanStatus {
  runId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  folders: FolderScan[];
  currentFolderId: string | null;
  grouping: { itemsCreated: number; filesAttached: number; ambiguous: number } | null;
  error: string | null;
}

export interface AppState {
  demo: boolean;
  platform: string;
  folders: number;
  items: number;
  scanRunning: boolean;
}

export type Progress =
  'not_started' | 'sampled' | 'into_it' | 'halfway' | 'nearly_done' | 'finished' | 'dnf';
export type DnfReason = 'not_for_me' | 'not_now' | 'too_difficult';
export type Precision = 'exact' | 'approximate' | 'unknown';
export type Kind = 'fiction' | 'nonfiction' | 'self_help' | 'tech' | 'comic' | 'manga';

export const PROGRESS_LABELS: Record<Progress, string> = {
  not_started: 'Not started',
  sampled: 'Sampled',
  into_it: 'Into it',
  halfway: 'Halfway',
  nearly_done: 'Nearly done',
  finished: 'Finished',
  dnf: 'Did not finish',
};

export const DNF_LABELS: Record<DnfReason, string> = {
  not_for_me: 'Not for me',
  not_now: 'Not now',
  too_difficult: 'Too difficult right now',
};

export const KIND_LABELS: Record<Kind, string> = {
  fiction: 'Fiction',
  nonfiction: 'Nonfiction',
  self_help: 'Self-help',
  tech: 'Tech',
  comic: 'Comic',
  manga: 'Manga',
};

export const FORMAT_LABELS: Record<string, string> = {
  epub: 'EPUB',
  pdf: 'PDF',
  cbz: 'CBZ',
  cbr: 'CBR',
  mobi: 'MOBI',
  azw3: 'AZW3',
  cb7: 'CB7',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}
