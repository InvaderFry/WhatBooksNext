import { useEffect, useState } from 'react';
import { api, formatDate, STORE_LABELS, type RefreshStatus } from '../api.ts';
import { LoadError, Notice } from '../components.tsx';

interface DiagFolder {
  id: string;
  name: string;
  storageKind: string;
  volumeLabel: string | null;
  hasVolumeIdentity: boolean;
  reachable: boolean;
  foundAt: string | null;
  lastLetter: string | null;
  lastCompleteScanAt: string | null;
  files: Record<string, number>;
}

interface Diag {
  app: { schemaVersion: number; node: string; platform: string; demo: boolean };
  lastSnapshot: { kind: string; createdAt: string } | null;
  snapshots: { preMigration: number; preRestore: number; full: number };
  dataFolder: string | null;
  lastLaunch: {
    action: 'open' | 'show';
    ok: boolean;
    asked?: boolean;
    at: string;
    error: string | null;
  } | null;
  placeholderDetection: string;
  folders: DiagFolder[];
  deepScan: { filesRead: number; filesHashed: number; problems: number; covers: number };
  onlineCovers: {
    bySource: Record<string, number>;
    none: number;
    failed: number;
    waiting: number;
    running: boolean;
    automatic: boolean;
  };
  sources: {
    label: string;
    configured: boolean;
    state: string;
    lastError: string | null;
    lastErrorAt: string | null;
    lastSuccessAt: string | null;
    requests: number;
    note: string;
  }[];
  ratings: {
    tiers: Record<string, number>;
    unknown: number;
    whatNext: { total: number; provisional: number };
  };
  lookups: { pending: number; running: boolean };
  refresh: RefreshStatus;
  /** The last store purchases import per store: counts only, never titles. */
  storeImports?: {
    service: string;
    importedAt: string;
    adapterVersion: string;
    completion: string;
    reason: string;
    counts: { seen?: number; included?: number; uncertain?: number; added?: number };
  }[];
}

interface RatingChanges {
  items: number;
  changedSource: number;
  gained: number;
  lost: number;
  movedTier: number;
  tierMoves: Record<string, number>;
  modes: { mode: string; before: number; after: number; entering: number; leaving: number }[];
  sourceTargets: { source: string; before: number; after: number }[];
}

const MODE_NAMES: Record<string, string> = {
  hidden_gems: 'Hidden gems',
  classics: 'Classics',
  waiting: 'Waiting on your shelf',
};

/** Plain lines, for the page and the copied report alike. */
function ratingChangeLines(c: RatingChanges): string[] {
  return [
    `Compared with the old fixed rating order, across ${c.items} books:`,
    `  rating now from a different source: ${c.changedSource}; gained a rating: ${c.gained}; lost a rating: ${c.lost}`,
    `  moved evidence tier: ${c.movedTier}${
      Object.keys(c.tierMoves).length
        ? ` (${Object.entries(c.tierMoves)
            .map(([k, n]) => `${k}: ${n}`)
            .join(', ')})`
        : ''
    }`,
    ...c.modes.map(
      (m) =>
        `  ${MODE_NAMES[m.mode] ?? m.mode}: ${m.before} before, ${m.after} now (${m.entering} joined, ${m.leaving} left)`,
    ),
  ];
}

/** Stage 1 before/after on this library: counts only, never titles, run on request. */
function RatingChangeCheck({ onResult }: { onResult: (c: RatingChanges) => void }) {
  const [result, setResult] = useState<RatingChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<RatingChanges>('/api/diagnostics/rating-changes', {});
            setResult(r);
            onResult(r);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Comparing…' : 'Compare with the old rating order'}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {result && (
        <ul className="plain">
          {ratingChangeLines(result).map((l) => (
            <li key={l}>{l.trim()}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface HardcoverTest {
  ok: boolean;
  results: {
    book: string;
    results?: number;
    error?: string;
    top?: {
      title?: string;
      rating: string;
      ratingsCount: number;
      pages: number | null;
      series: string | null;
      year: number | null;
      genres: number;
    } | null;
  }[];
  rateLimit: Record<string, string>;
  requestsToday: number;
}

/** Saved online covers, by source: "12 from Hardcover, 3 from Open Library". */
function coversSaved(d: Diag): string {
  const parts = Object.entries(d.onlineCovers.bySource).map(
    ([source, n]) => `${n.toLocaleString()} from ${SOURCE_NAMES[source] ?? source}`,
  );
  return parts.length ? parts.join(', ') : 'none saved yet';
}

const SOURCE_NAMES: Record<string, string> = {
  openlibrary: 'Open Library',
  hardcover: 'Hardcover',
  metron: 'Metron',
  comicvine: 'ComicVine',
  anilist: 'AniList',
};

/** Plain-language checks any user can run, with a copyable report (PLAN.md §15). */
export function Diagnostics() {
  const [names, setNames] = useState(false);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ratingChanges, setRatingChanges] = useState<RatingChanges | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    api
      .get<Diag>(`/api/diagnostics${names ? '?names=1' : ''}`)
      .then(setDiag)
      .catch((e: Error) => setError(e.message));
  }, [names, reloadKey]);

  const report = diag
    ? [toReport(diag), ...(ratingChanges ? ['', ...ratingChangeLines(ratingChanges)] : [])].join(
        '\n',
      )
    : '';

  return (
    <div className="page">
      <div className="page-head">
        <h1>Diagnostics</h1>
        <p className="muted">
          Checks you can run and share if something seems wrong. No API keys are ever included.
        </p>
      </div>
      {error && !diag && (
        <LoadError
          message={error}
          onRetry={() => {
            setError(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {error && diag && <Notice kind="error">{error}</Notice>}
      {!diag && !error && <p className="muted">Loading…</p>}
      {diag && (
        <>
          <section className="section" aria-labelledby="drives-h">
            <h2 id="drives-h">Folders and drives</h2>
            <ul className="check-list">
              {diag.folders.length === 0 && <li>No folders added yet.</li>}
              {diag.folders.map((f) => (
                <li key={f.id} className="card">
                  <strong>{f.name}</strong> — {f.storageKind}
                  <ul>
                    <li>
                      {f.reachable ? '✓ Found' : '✕ Not found'}
                      {f.foundAt ? ` at ${f.foundAt}` : ''}
                      {f.lastLetter ? ` (last seen as ${f.lastLetter}:)` : ''}
                    </li>
                    <li>
                      {f.hasVolumeIdentity
                        ? '✓ Drive identity recorded — the folder is found even if its drive letter changes'
                        : 'Found by path only (no drive identity on this system)'}
                    </li>
                    <li>
                      Files by state:{' '}
                      {Object.entries(f.files)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(', ') || 'none yet'}
                    </li>
                    <li>Last complete scan: {formatDate(f.lastCompleteScanAt)}</li>
                  </ul>
                </li>
              ))}
            </ul>
          </section>
          <section className="section" aria-labelledby="app-h">
            <h2 id="app-h">App</h2>
            <ul className="plain">
              <li>Online-only detection: {diag.placeholderDetection}</li>
              <li>Database version {diag.app.schemaVersion}</li>
              <li>
                Last safety snapshot:{' '}
                {diag.lastSnapshot
                  ? `${diag.lastSnapshot.kind}, ${formatDate(diag.lastSnapshot.createdAt)}`
                  : 'none yet'}
              </li>
              <li>
                Node.js {diag.app.node} · {diag.app.platform}
              </li>
              <li>
                Deep scan: {diag.deepScan.filesRead.toLocaleString()} files read,{' '}
                {diag.deepScan.filesHashed.toLocaleString()} fingerprinted,{' '}
                {diag.deepScan.covers.toLocaleString()} covers, {diag.deepScan.problems} with
                problems (see Library health)
              </li>
              <li>
                Online covers (books without a file cover): {coversSaved(diag)}
                {diag.onlineCovers.none > 0 && `, ${diag.onlineCovers.none} with no cover online`}
                {diag.onlineCovers.failed > 0 &&
                  `, ${diag.onlineCovers.failed} couldn’t be used`},{' '}
                {diag.onlineCovers.waiting.toLocaleString()} waiting
                {diag.onlineCovers.running && ' (getting covers now)'}
                {!diag.onlineCovers.automatic &&
                  '. Automatic lookups are off, so covers come only when you ask'}
                {diag.onlineCovers.waiting > 0 && !diag.onlineCovers.running && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="small"
                      onClick={async () => {
                        try {
                          await api.post('/api/covers/fetch', {});
                          setReloadKey((k) => k + 1);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Get covers now
                    </button>
                  </>
                )}
              </li>
              <li>
                Books waiting for an online lookup: {diag.lookups.pending.toLocaleString()}
                {diag.lookups.running && ' (lookups running now)'}
              </li>
              <li>
                Snapshots kept: {diag.snapshots.preMigration} before updates,{' '}
                {diag.snapshots.preRestore} before restores, {diag.snapshots.full} full (Settings →
                Export and snapshots)
              </li>
              {diag.dataFolder && <li>Data folder: {diag.dataFolder}</li>}
              <li>
                {launchText(diag.lastLaunch)}
                {!diag.lastLaunch?.ok &&
                  ' To check it, press Open on any book’s page, then come back here.'}
              </li>
            </ul>
          </section>
          <section className="section" aria-labelledby="ratings-h">
            <h2 id="ratings-h">Rating evidence</h2>
            <p className="muted">All library items, including finished and read elsewhere.</p>
            <p className="muted">{DETAIL_POLICY}</p>
            <ul className="plain">
              {Object.entries(diag.ratings.tiers).map(([tier, count]) => (
                <li key={tier}>
                  Tier {tier} — {RATING_TIERS[tier]}: {count}
                </li>
              ))}
              <li>Unknown: {diag.ratings.unknown}</li>
              <li>
                Default What next picks using an unconfirmed rating (tier 5):{' '}
                {diag.ratings.whatNext.provisional} of {diag.ratings.whatNext.total}
              </li>
            </ul>
            <p className="muted">
              See how the new rating choice changed your library: counts only, never titles. It is
              added to the report below.
            </p>
            <RatingChangeCheck onResult={setRatingChanges} />
          </section>
          <section className="section" aria-labelledby="sources-h">
            <h2 id="sources-h">Online sources</h2>
            <ul className="check-list">
              {diag.sources.map((s) => (
                <li key={s.label} className="card">
                  <strong>{s.label}</strong>:{' '}
                  {!s.configured
                    ? 'no key (optional)'
                    : s.state === 'paused'
                      ? '✕ paused after repeated errors'
                      : s.lastError && (!s.lastSuccessAt || s.lastErrorAt! > s.lastSuccessAt)
                        ? '✕ last request failed'
                        : s.lastSuccessAt
                          ? '✓ connected'
                          : 'ready (not used yet since the app started)'}
                  <div className="muted small">{s.note}</div>
                  {s.lastError && <div className="small warn">Last error: {s.lastError}</div>}
                </li>
              ))}
            </ul>
            <RefreshDiagnostics r={diag.refresh} />
            <div className="card">
              <h3>Store purchase imports</h3>
              {diag.storeImports?.length ? (
                <ul className="plain-list small">
                  {diag.storeImports.map((s) => (
                    <li key={s.service}>{storeImportLine(s)}</li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">None yet.</p>
              )}
            </div>
            <HardcoverCheck names={names} />
            <ComicCheck source="metron" title="Metron" names={names} />
            <ComicCheck source="comicvine" title="ComicVine" names={names} />
          </section>
          <section className="section" aria-labelledby="report-h">
            <h2 id="report-h">Report</h2>
            <label className="check">
              <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} />
              Include folder names and paths
            </label>
            <label htmlFor="report" className="visually-hidden">
              Report text
            </label>
            <textarea id="report" className="report" readOnly rows={12} value={report} />
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(report);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2500);
              }}
            >
              Copy report
            </button>
            <span className="live" aria-live="polite">
              {copied && ' ✓ Copied'}
            </span>
          </section>
        </>
      )}
    </div>
  );
}

const DETAIL_POLICY =
  'Online details use confirmed or accepted matches. Unconfirmed matches stay under Possible matches. Details are chosen from stored data, without new requests.';

const RATING_TIERS: Record<string, string> = {
  1: 'trusted book or volume, supported',
  2: 'trusted whole series, supported',
  3: 'trusted book or volume, few or unknown ratings',
  4: 'trusted whole series, few or unknown ratings',
  5: 'unconfirmed match',
};

function toReport(d: Diag): string {
  const lines = [
    'whatBooksNext diagnostics',
    `Database version ${d.app.schemaVersion}; Node ${d.app.node}; ${d.app.platform}${d.app.demo ? '; DEMO' : ''}`,
    `Last snapshot: ${d.lastSnapshot ? `${d.lastSnapshot.kind} ${d.lastSnapshot.createdAt}` : 'none'}`,
    `Online-only detection: ${d.placeholderDetection}`,
    `Snapshots: ${d.snapshots.preMigration} pre-migration, ${d.snapshots.preRestore} pre-restore, ${d.snapshots.full} full`,
    ...(d.dataFolder ? [`Data folder: ${d.dataFolder}`] : []),
    launchText(d.lastLaunch),
    '',
    ...d.folders.flatMap((f) => [
      `${f.name} (${f.storageKind})${f.volumeLabel ? ` "${f.volumeLabel}"` : ''}`,
      `  found: ${f.reachable ? 'yes' : 'no'}${f.foundAt ? ` at ${f.foundAt}` : ''}; last letter: ${f.lastLetter ?? '-'}; drive identity: ${f.hasVolumeIdentity ? 'yes' : 'no'}`,
      `  files: ${
        Object.entries(f.files)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || 'none'
      }`,
      `  last complete scan: ${f.lastCompleteScanAt ?? 'never'}`,
    ]),
    '',
    `Deep scan: ${d.deepScan.filesRead} read, ${d.deepScan.filesHashed} hashed, ${d.deepScan.covers} covers, ${d.deepScan.problems} problems`,
    `Online covers: ${coversSaved(d)}, ${d.onlineCovers.none} none, ${d.onlineCovers.failed} unusable, ${d.onlineCovers.waiting} waiting${d.onlineCovers.running ? ' (running)' : ''}${d.onlineCovers.automatic ? '' : ' (automatic lookups off)'}`,
    `Lookups waiting: ${d.lookups.pending}${d.lookups.running ? ' (running)' : ''}`,
    ...Object.entries(d.ratings.tiers).map(
      ([tier, count]) => `Rating tier ${tier} (${RATING_TIERS[tier]}): ${count}`,
    ),
    `Rating unknown: ${d.ratings.unknown}`,
    DETAIL_POLICY,
    `Default What next picks on tier 5: ${d.ratings.whatNext.provisional} of ${d.ratings.whatNext.total}`,
    ...d.sources.map(
      (s) =>
        `${s.label}: ${s.configured ? s.state : 'no key'}; requests this run ${s.requests}${s.lastError ? `; last error: ${s.lastError}` : ''}`,
    ),
    ...refreshLines(d.refresh),
    ...(d.storeImports ?? []).map(storeImportLine),
  ];
  return lines.join('\n');
}

/** One store's last import, title-free: when, collector version, completeness and counts. */
function storeImportLine(s: NonNullable<Diag['storeImports']>[number]): string {
  const c = s.counts;
  return `Store import ${STORE_LABELS[s.service] ?? s.service}: ${s.importedAt}; collector ${s.adapterVersion}; ${s.completion} (${s.reason}); found ${c.seen ?? '?'}, included ${c.included ?? '?'}, uncertain ${c.uncertain ?? '?'}, added ${c.added ?? 0}`;
}

/** Automatic refresh per source: due, last answer, automatic requests today, pauses, failures. */
function refreshLines(r: RefreshStatus): string[] {
  return [
    `Automatic refresh: ${r.demo ? 'off in the demo' : r.enabled ? (r.paused ? 'paused' : 'on') : 'off'}; ${r.dueBooks} books due${r.fresh ? '; looking up all books again' : ''}`,
    ...r.sources.map(
      (s) =>
        `  ${s.label}: ${s.due} of ${s.books} due; last answer ${s.lastAnswerAt ?? 'never'}; automatic requests today ${s.automaticToday}${s.automaticAllowance !== null ? ` of ${s.automaticAllowance}` : ''}; failing ${s.failing}${s.pausedBecause ? `; paused: ${s.pausedBecause}` : ''}`,
    ),
  ];
}

function RefreshDiagnostics({ r }: { r: RefreshStatus }) {
  return (
    <div className="card">
      <h3>Automatic refresh</h3>
      <p className="small">
        {r.demo
          ? 'Off in the demo.'
          : `${r.enabled ? (r.paused ? 'Paused.' : 'On.') : 'Off.'} ${r.dueBooks.toLocaleString()} books due now.${r.lastCheckAt ? ` Last check ${formatDate(r.lastCheckAt)}.` : ''}`}
      </p>
      {r.sources.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Due</th>
              <th scope="col">Last answer</th>
              <th scope="col">Automatic requests today</th>
              <th scope="col">Failing</th>
              <th scope="col">Paused</th>
            </tr>
          </thead>
          <tbody>
            {r.sources.map((s) => (
              <tr key={s.source}>
                <th scope="row">{s.label}</th>
                <td>
                  {s.due.toLocaleString()} of {s.books.toLocaleString()}
                </td>
                <td>{s.lastAnswerAt ? formatDate(s.lastAnswerAt) : 'never'}</td>
                <td>
                  {s.automaticToday.toLocaleString()}
                  {s.automaticAllowance !== null && ` of ${s.automaticAllowance.toLocaleString()}`}
                </td>
                <td>{s.failing.toLocaleString()}</td>
                <td>{s.pausedBecause ?? 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * "Open works on a chosen file" (§15): how the last Open / Show in folder went. The app can tell
 * that the system started the request, not that an app then showed the book, so it says so.
 */
function launchText(l: Diag['lastLaunch']): string {
  if (!l) return 'Open: not tried since the app started.';
  const what = l.action === 'open' ? 'Open' : 'Show in folder';
  const when = new Date(l.at).toLocaleString();
  if (l.ok) return `${what}: the system started it (${when}). Check that the book appeared.`;
  if (l.asked) return `${what}: stopped to ask before downloading from the cloud (${when}).`;
  return `${what}: failed (${when}): ${l.error ?? 'no detail'}`;
}

/**
 * Test Hardcover (§12.1): a few real lookups from the library, what came back, and the
 * rate-limit headers, as a report to share. Titles only if the names box is ticked.
 */
function HardcoverCheck({ names }: { names: boolean }) {
  const [result, setResult] = useState<HardcoverTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = result
    ? [
        `Hardcover test: ${result.ok ? 'OK' : 'problems'}`,
        ...result.results.map((r) =>
          r.error
            ? `${r.book}: error: ${r.error}`
            : `${r.book}: ${r.results} results; top: ${
                r.top
                  ? `${r.top.title ? `"${r.top.title}", ` : ''}rating ${r.top.rating} (${r.top.ratingsCount} rating${r.top.ratingsCount === 1 ? '' : 's'}), pages ${r.top.pages ?? '-'}, series ${r.top.series ?? '-'}, year ${r.top.year ?? '-'}, ${r.top.genres} genres/tags`
                  : 'none'
              }`,
        ),
        `Rate-limit headers: ${
          Object.entries(result.rateLimit)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || 'none sent'
        }`,
        `Requests today by this app: ${result.requestsToday}`,
      ].join('\n')
    : '';
  return (
    <div className="card">
      <h3>Test Hardcover</h3>
      <p className="small muted">
        Looks up three books from your library on Hardcover and shows what came back. Uses three of
        today’s 5,000 requests.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setResult(await api.post<HardcoverTest>('/api/diagnostics/hardcover-test', { names }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Testing…' : 'Test Hardcover'}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {result && (
        <>
          <label htmlFor="hc-report" className="visually-hidden">
            Hardcover test report
          </label>
          <textarea id="hc-report" className="report" readOnly rows={7} value={text} />
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2500);
            }}
          >
            Copy test report
          </button>
          <span className="live" aria-live="polite">
            {copied && ' ✓ Copied'}
          </span>
        </>
      )}
    </div>
  );
}

interface Candidate {
  title?: string;
  score: number;
  years: number[];
  status: string;
  total: number | null;
  link: boolean;
}

const candidateText = (c: Candidate | null | undefined) =>
  c
    ? `${c.title ? `"${c.title}", ` : ''}score ${c.score}, years ${c.years.join('/') || '-'}, series ${c.status}${c.total ? ` (${c.total} issues)` : ''}, link ${c.link ? 'yes' : 'no'}`
    : 'none';

interface ComicTest {
  ok: boolean;
  results: {
    issue: string;
    results?: number;
    decision?: string;
    error?: string;
    fileYears?: number[];
    runHint?: boolean;
    top?: Candidate | null;
    next?: Candidate | null;
  }[];
  rateLimit: Record<string, string>;
  requestsToday: number | null;
}

/**
 * Test Metron / Test ComicVine: real lookups of single issues from the library, what came back
 * and the rate-limit headers, as a report to share. Titles only if the names box is ticked.
 */
function ComicCheck({
  source,
  title,
  names,
}: {
  source: 'metron' | 'comicvine';
  title: string;
  names: boolean;
}) {
  const [result, setResult] = useState<ComicTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = result
    ? [
        `${title} test: ${result.ok ? 'OK' : 'problems'}`,
        ...result.results.map((r) =>
          r.error
            ? `${r.issue}: error: ${r.error}`
            : `${r.issue}: ${r.results} results, decision ${r.decision}; file years ${r.fileYears?.join('/') || 'none'}${r.runHint ? ', run known from its folder' : ''}; top: ${candidateText(r.top)}; next: ${candidateText(r.next)}`,
        ),
        `Rate-limit headers: ${
          Object.entries(result.rateLimit)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || 'none sent'
        }`,
        ...(result.requestsToday !== null
          ? [`Requests today by this app: ${result.requestsToday}`]
          : []),
      ].join('\n')
    : '';
  const id = `${source}-report`;
  return (
    <div className="card">
      <h3>Test {title}</h3>
      <p className="small muted">
        {source === 'metron'
          ? 'Looks up three single comic issues from your library on Metron. Uses up to nine of today’s 5,000 requests.'
          : 'Looks up one single comic issue on ComicVine. Takes about 20 seconds: ComicVine allows only 200 requests an hour.'}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setResult(await api.post<ComicTest>('/api/diagnostics/comic-test', { source, names }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Testing…' : `Test ${title}`}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {result && (
        <>
          <label htmlFor={id} className="visually-hidden">
            {title} test report
          </label>
          <textarea id={id} className="report" readOnly rows={6} value={text} />
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2500);
            }}
          >
            Copy test report
          </button>
          <span className="live" aria-live="polite">
            {copied && ' ✓ Copied'}
          </span>
        </>
      )}
    </div>
  );
}
