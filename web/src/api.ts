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
  put: <T>(url: string, body: unknown) => call<T>('PUT', url, body),
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
  triage: 'want' | 'maybe' | 'never' | null;
  effortOverride: 'light' | 'medium' | 'heavy' | null;
  preferredFileId: string | null;
  /** The owner's series name ('' = not in a series); null lets the app decide. */
  seriesOverride: string | null;
  seriesPositionOverride: number | null;
}

export type SeriesUnit = 'volume' | 'issue';

export interface ItemSummary {
  id: string;
  title: string;
  factTitle: string;
  kind: Kind | null;
  kindIsGuess: boolean;
  isReference: boolean;
  seriesHint: string | null;
  series: { id: string; name: string; position: number | null; unit: SeriesUnit } | null;
  creators: { name: string; role?: string }[];
  /** File whose thumbnail is this item's cover; null when there is none. */
  coverFileId: string | null;
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
  wordCount: number | null;
  pageCount: number | null;
  pdfType: PdfType | 'uncertain' | null;
  pdfTypeEvidence: string | null;
  pdfTypeOverride: PdfType | null;
  hasThumbnail: boolean;
  hashed: boolean;
  problem: string | null;
  problemDetail: string | null;
  metadata: EmbeddedMetadata | null;
}

export type PdfType = 'comic' | 'text' | 'scanned';

/** What a file says about itself. Untrusted text: always rendered as text, never as HTML. */
export interface EmbeddedMetadata {
  title?: string;
  creators?: { name: string; role?: string }[];
  language?: string;
  publisher?: string;
  date?: string;
  identifiers?: { scheme: string; value: string }[];
  isbnCandidates?: string[];
  subjects?: string[];
  description?: string;
  series?: string;
  seriesIndex?: string;
  comic?: Record<string, string | number>;
}

export interface ItemDetail extends ItemSummary {
  files: FileDetail[];
  parse: Record<string, unknown> | null;
  titleSource: 'embedded' | 'filename' | null;
  redirectedFrom?: string;
}

export interface ReviewFile {
  id: string;
  name: string;
  folderPath: string;
  relPath: string;
  format: string;
  size: number;
  availability: string;
}

export interface ReviewRow {
  id: string;
  kind:
    | 'move'
    | 'group_conflict'
    | 'copy_conflict'
    | 'cross_folder'
    | 'pdf_type'
    | 'tie'
    | 'wrong_match'
    | 'unidentified'
    | 'provisional';
  tier: number;
  why: string;
  items: { id: string; title: string; hasHistory: boolean }[];
  files: ReviewFile[];
  actions: ('accept' | 'decline' | 'split')[];
  candidates?: Candidate[];
}

export interface ReviewList {
  tiers: Record<number, number>;
  rows: ReviewRow[];
  notListed: { provisional: number; unidentified: number };
  hidden: number;
}

export interface HealthFile {
  fileId: string;
  itemId: string | null;
  name: string;
  folderPath: string;
  relPath: string;
  format: string;
  size: number;
  problem: string | null;
  detail: string | null;
  at: string | null;
}

export interface Health {
  errors: HealthFile[];
  notComics: HealthFile[];
  noTextLayer: HealthFile[];
  uncertainPdfs: number;
  itemsWithCopies: number;
  filesInCopies: number;
  notYetRead: number;
  notYetHashed: number;
  ignoredByType: Record<string, number>;
}

export interface Reminder {
  folderId: string;
  displayPath: string;
  storageKind: 'local' | 'external' | 'cloud';
  days: number;
  neverCompleted: boolean;
}

export interface DeepProgress {
  phase: 'reading' | 'hashing' | 'done';
  toRead: number;
  read: number;
  bytesToRead: number;
  bytesRead: number;
  toHash: number;
  hashed: number;
  bytesToHash: number;
  bytesHashed: number;
  failed: number;
  refused: number;
  estimateSeconds: number | null;
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
  reparsed: number;
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
  phase?: 'listing' | 'reading' | 'hashing' | 'finishing';
  deep?: DeepProgress | null;
  identity?: { excluded: number; split: number; mergedByHash: number; reviewAdded: number } | null;
  error: string | null;
}

export interface AppState {
  demo: boolean;
  platform: string;
  folders: number;
  items: number;
  scanRunning: boolean;
  reviewOpen: number;
  healthProblems: number;
  lookupsRunning: boolean;
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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${h} h${rest ? ` ${rest} min` : ''}`;
}

export const PDF_TYPE_LABELS: Record<string, string> = {
  comic: 'Comic',
  text: 'Text book',
  scanned: 'Scanned book',
  uncertain: 'Uncertain',
};

export const PROBLEM_LABELS: Record<string, string> = {
  corrupt: 'Unreadable or damaged',
  limit: 'Over a safety limit',
  timeout: 'Took too long to read',
  not_comic: 'Archive that isn’t a comic',
  too_large: 'Too large to read',
  encrypted: 'Password-protected',
};

// ---- Milestone 3: lookups and recommendations ------------------------------------------------

export interface Card {
  id: string;
  title: string;
  kind: Kind | null;
  creators: { name: string; role?: string }[];
  coverFileId: string | null;
  formats: string[];
  availability: Availability;
  progress: Progress;
  shortlisted: boolean;
  scope: string;
  series: { id: string; name: string } | null;
  gaps: CardGap[];
  lengthBasis: string | null;
  fit: 'fits' | 'might_fit' | 'too_long' | 'unknown' | 'any';
  reasons: string[];
  limitations: string[];
  score: number;
  topics?: string[];
  /** Still relevant? only (§13.10). */
  signals?: string[];
  deferred?: boolean;
}

export interface CardGap {
  text: string;
  from: number;
  to: number;
  unit: SeriesUnit;
  state: 'not_owned' | 'unavailable' | 'maybe_covered';
  coveredBy?: { itemId: string; title: string; coverageId: string };
}

export interface CoverageRow {
  id: string;
  seriesId: string;
  seriesName: string;
  first: number;
  last: number;
  state: 'suggested' | 'confirmed';
  source: string;
}

export interface SeriesEntry {
  id: string;
  title: string;
  position: number | null;
  label: string | null;
  unit: SeriesUnit;
  progress: Progress;
  holding: 'owned' | 'unavailable' | 'read_elsewhere' | null;
  availabilityLabel: string | null;
  formats: string[];
  via?: 'collection' | 'issues' | null;
}

export interface SeriesView {
  id: string;
  name: string;
  runLabel?: string | null;
  publications: null | {
    source: string;
    checkedAt: string;
    volumes: { position: number; title: string; sourceId: string; publishedOn: string }[];
    missing: { position: number; title: string; sourceId: string; publishedOn: string }[];
    missingRanges: { from: number; to: number }[];
  };
  publicationLookup?: { available: boolean; reason: string | null };
  kind: Kind | null;
  status: 'finished' | 'ongoing' | 'unknown';
  statusSource: string | null;
  ownerStatus: 'finished' | 'ongoing' | null;
  total: number | null;
  orderSource: string | null;
  entries: SeriesEntry[];
  gaps: CardGap[];
  coverage: {
    id: string;
    itemId: string;
    title: string;
    first: number;
    last: number;
    state: 'suggested' | 'confirmed';
    held: boolean;
  }[];
  missingAfter: { from: number; to: number } | null;
  unnumbered: number;
}

export interface TimePreset {
  id: string;
  label: string;
  minutes: number | null;
}

export type ModeId =
  | 'read_next'
  | 'continue'
  | 'next_in_series'
  | 'one_sitting'
  | 'waiting'
  | 'hidden_gems'
  | 'classics'
  | 'still_relevant'
  | 'mood'
  | 'surprise';
export type Mood = 'escape' | 'learn' | 'skim';

export interface ReadNext {
  view: ModeId;
  cards: Card[];
  mightFit: Card[];
  total: number;
  coverage: { eligible: number; rated: number; lengthKnown: number };
  leftOut?: { ongoing: number; unknown: number; missing: number };
  empty?: string;
  situation: {
    time: string;
    mode: 'read_for' | 'finish_within';
    ready: boolean;
    show: 'all' | 'books' | 'tech' | 'comics';
    mood: Mood | null;
    complete: boolean;
    topic: string | null;
  };
  modes: { id: ModeId; label: string; description: string; usesTime: boolean }[];
  moods: { id: Mood; label: string; description: string }[];
  topics: string[];
  taste: { on: boolean; outcomes: number };
  stillReading: number;
  presets: TimePreset[];
  lookups: { pending: number; running: boolean };
  hardcover: boolean | null;
}

export interface SourceStatus {
  source: string;
  label: string;
  configured: boolean;
  state: 'ok' | 'paused';
  consecutiveFailures: number;
  pausedUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  requests: number;
  rateLimit: Record<string, string>;
  note: string;
}

export interface LookupStatus {
  runId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  outcomes: Record<string, number>;
  errors: string[];
  estimateSeconds: number | null;
  series?: { done: number; total: number };
  error: string | null;
}

export interface Lookups {
  status: LookupStatus | null;
  pending: number;
  pendingSeries: number;
  sources: SourceStatus[];
  afterScan: boolean;
}

export interface Candidate {
  source: string;
  sourceLabel: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  year: number | null;
  score: number;
  notes: string[];
  url: string | null;
  rating: string | null;
}

export interface Duration {
  low: number;
  high: number;
  basis: string;
  measured: boolean;
  unit: 'book' | 'volume' | 'issue';
}

export interface ItemOnline {
  identity: 'accepted' | 'provisional' | 'tie' | 'unidentified';
  matchConfirmed: boolean;
  override: string | null;
  lookups: {
    source: string;
    sourceLabel: string;
    outcome: string;
    looked_up_at: string;
    error: string | null;
  }[];
  sources: { source: string; sourceLabel: string; decision: string; chosen: Candidate | null }[];
  candidates: Candidate[];
  community: {
    source: string;
    raw: number;
    scale: number;
    votes: number | null;
    scope: 'book' | 'volume' | 'series';
    score: number;
    highlyRated: boolean;
  } | null;
  duration: Duration | null;
  effort: 'light' | 'medium' | 'heavy' | 'unknown';
  firstPublishYear: number | null;
  acquired: {
    date: string | null;
    basis: 'entered' | 'file_date' | 'first_seen' | 'unknown';
  } | null;
  eligibleBecause: string | null;
  card: Card | null;
  description: string | null;
  subjects: string[];
  lookupAvailable: boolean;
}

export interface TriageList {
  source: 'all' | 'new' | 'folder';
  folder: string | null;
  remaining: number;
  triaged: number;
  newArrivals: number;
  lastScan: { id: string; newItems: number } | null;
  folders: { id: string; path: string; untriaged: number }[];
  items: (Card & {
    kindIsGuess: boolean;
    description: string | null;
    firstPublishYear: number | null;
  })[];
}

export interface MatchReport {
  byBand: {
    accepted: number;
    provisional: number;
    tie: number;
    unidentified: number;
    notLookedUp: number;
    noSourceYet: number;
  };
  byFormat: Record<string, { items: number; identified: number }>;
  byKind: Record<string, { items: number; identified: number }>;
  labelled: {
    confirmed: number;
    rejected: number;
    wrongHighConfidence: number;
    precision: number | null;
  };
  coverage: {
    kind: string;
    items: number;
    rated: number;
    lengthKnown: number;
    seriesKnown: number;
  }[];
}

export const EFFORT_LABELS: Record<string, string> = {
  light: 'Light',
  medium: 'Medium',
  heavy: 'Heavy',
  unknown: 'Unknown',
};

/** "~15–25 min", "~4–5 h" — the same rounding as the server's cards. */
export function formatRange(d: { low: number; high: number }): string {
  const step = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  if (d.high < 60) {
    const a = step(d.low);
    const b = step(d.high);
    return a === b ? `~${a} min` : `~${a}–${b} min`;
  }
  const r = (x: number) => (x < 10 ? Math.round(x * 2) / 2 : Math.round(x));
  const a = r(d.low / 60);
  const b = Math.max(r(d.high / 60), a);
  return a === b ? `~${a} h` : `~${a}–${b} h`;
}

export interface Signal {
  key: string;
  label: string;
  type: 'genre' | 'author' | 'artist' | 'publisher' | 'kind';
  affinity: number;
  evidence: number;
  rated: boolean;
  stopped: boolean;
  meanRating: number | null;
  text: string;
}

export type WeightKey = 'rating' | 'timeFit' | 'taste' | 'momentum' | 'triage' | 'recency';
export type TasteStrength = 'off' | 'low' | 'normal' | 'high';

export interface Tune {
  weights: Record<WeightKey, number>;
  defaults: Record<WeightKey, number>;
  explain: Record<WeightKey, { label: string; explain: string }>;
  strength: TasteStrength;
  taste: {
    active: boolean;
    outcomes: number;
    groups: number;
    threshold: number;
    minGroups: number;
    strength: TasteStrength;
    likes: Signal[];
    dislikes: Signal[];
  };
}

export interface BulkPreview {
  action: 'read' | 'never';
  count: number;
  changes: number;
  already: number;
  inProgress: { id: string; title: string; progress: Progress }[];
  shortlisted: { id: string; title: string }[];
}
