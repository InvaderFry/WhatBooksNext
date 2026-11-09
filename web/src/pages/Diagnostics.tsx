import { useEffect, useState } from 'react';
import { api, formatDate } from '../api.ts';
import { Notice } from '../components.tsx';

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
  placeholderDetection: string;
  folders: DiagFolder[];
  deepScan: { filesRead: number; filesHashed: number; problems: number; covers: number };
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
  lookups: { pending: number; running: boolean };
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

/** Plain-language checks any user can run, with a copyable report (PLAN.md §15). */
export function Diagnostics() {
  const [names, setNames] = useState(false);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Diag>(`/api/diagnostics${names ? '?names=1' : ''}`)
      .then(setDiag)
      .catch((e: Error) => setError(e.message));
  }, [names]);

  const report = diag ? toReport(diag) : '';

  return (
    <div className="page">
      <div className="page-head">
        <h1>Diagnostics</h1>
        <p className="muted">
          Checks you can run and share if something seems wrong. No API keys are ever included.
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
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
                Books waiting for an online lookup: {diag.lookups.pending.toLocaleString()}
                {diag.lookups.running && ' (lookups running now)'}
              </li>
              <li>
                Open: use the Open button on any book’s page to check it opens in your default app.
              </li>
            </ul>
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
            <HardcoverCheck names={names} />
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

function toReport(d: Diag): string {
  const lines = [
    'whatBooksNext diagnostics',
    `Database version ${d.app.schemaVersion}; Node ${d.app.node}; ${d.app.platform}${d.app.demo ? '; DEMO' : ''}`,
    `Last snapshot: ${d.lastSnapshot ? `${d.lastSnapshot.kind} ${d.lastSnapshot.createdAt}` : 'none'}`,
    `Online-only detection: ${d.placeholderDetection}`,
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
    `Lookups waiting: ${d.lookups.pending}${d.lookups.running ? ' (running)' : ''}`,
    ...d.sources.map(
      (s) =>
        `${s.label}: ${s.configured ? s.state : 'no key'}; requests this run ${s.requests}${s.lastError ? `; last error: ${s.lastError}` : ''}`,
    ),
  ];
  return lines.join('\n');
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
