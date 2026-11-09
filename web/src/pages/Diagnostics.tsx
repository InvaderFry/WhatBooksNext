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
  sources: string;
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
              <li>{diag.sources}</li>
              <li>
                Open: use the Open button on any book’s page to check it opens in your default app.
              </li>
            </ul>
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
    d.sources,
  ];
  return lines.join('\n');
}
