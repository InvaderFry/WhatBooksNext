import { useEffect, useState } from 'react';
import {
  api,
  formatBytes,
  formatDate,
  PROBLEM_LABELS,
  type Health as HealthData,
  type HealthFile,
} from '../api.ts';
import { LoadError } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/**
 * Library health (PLAN.md §15): files that couldn't be read, kept apart from things that are
 * merely incomplete, and from plain information.
 */
export function Health() {
  const [h, setH] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api
      .get<HealthData>('/api/health')
      .then(setH)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const ignored = h ? Object.entries(h.ignoredByType).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Library health</h1>
        <p className="muted">
          Files the scan couldn’t read, and what’s merely incomplete. The app never changes your
          files, so fixing these happens outside it.
        </p>
      </div>
      {error && <LoadError message={error} onRetry={load} />}
      {!h && !error && <p className="muted">Loading…</p>}
      {h && (
        <>
          <section className="section" aria-labelledby="errors-h">
            <h2 id="errors-h">Couldn’t be read ({h.errors.length})</h2>
            {h.errors.length === 0 ? (
              <p className="muted">None. Every file the scan reached could be read.</p>
            ) : (
              <>
                <p className="muted small">
                  These stay in the library by their filenames. The next scan tries them again.
                </p>
                <FileList files={h.errors} showProblem />
              </>
            )}
          </section>

          {h.notComics.length > 0 && (
            <section className="section" aria-labelledby="notcomic-h">
              <h2 id="notcomic-h">Archives that aren’t comics ({h.notComics.length})</h2>
              <p className="muted small">
                .zip and .rar files count as comics, but these don’t hold page images, so they’re
                left out of the library.
              </p>
              <FileList files={h.notComics} showProblem />
            </section>
          )}

          <section className="section" aria-labelledby="incomplete-h">
            <h2 id="incomplete-h">Incomplete, not broken</h2>
            <ul className="plain">
              <li>
                {h.noTextLayer.length === 0
                  ? 'No PDFs of page images without text.'
                  : `${h.noTextLayer.length} PDF${h.noTextLayer.length === 1 ? ' is' : 's are'} page images with no text, so ${h.noTextLayer.length === 1 ? 'its' : 'their'} length can only be guessed from pages:`}
              </li>
            </ul>
            {h.noTextLayer.length > 0 && <FileList files={h.noTextLayer} />}
            <ul className="plain">
              <li>
                {h.uncertainPdfs === 0
                  ? 'Every PDF’s type is known.'
                  : `${h.uncertainPdfs} PDF${h.uncertainPdfs === 1 ? '' : 's'} could be a comic or a book: answer in Needs review.`}
              </li>
              {h.notYetRead > 0 && (
                <li>{h.notYetRead.toLocaleString()} files not read yet: scan to continue.</li>
              )}
              {h.notYetHashed > 0 && (
                <li>
                  {h.notYetHashed.toLocaleString()} files not fingerprinted yet (used to recognise
                  moved and copied files): scan to continue.
                </li>
              )}
            </ul>
          </section>

          <section className="section" aria-labelledby="info-h">
            <h2 id="info-h">For information</h2>
            <ul className="plain">
              <li>
                {h.itemsWithCopies === 0
                  ? 'No book has copies in more than one folder.'
                  : `${h.itemsWithCopies.toLocaleString()} books have copies in more than one folder (${h.filesInCopies.toLocaleString()} files). That’s fine: each counts once.`}
              </li>
              <li>
                {ignored.length === 0
                  ? 'The last scan found no other file types.'
                  : `Other files the last scan skipped: ${ignored.map(([k, n]) => `${n.toLocaleString()} .${k}`).join(', ')}.`}
              </li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function FileList({ files, showProblem = false }: { files: HealthFile[]; showProblem?: boolean }) {
  return (
    <ul className="plain health-list">
      {files.map((f) => (
        <li key={f.fileId} className="card small">
          <div>
            {f.itemId ? (
              <a
                href={hrefFor({ view: 'item', id: f.itemId })}
                onClick={onLinkClick({ view: 'item', id: f.itemId })}
              >
                {f.name}
              </a>
            ) : (
              <strong>{f.name}</strong>
            )}
            <span className="muted">
              {' '}
              · {formatBytes(f.size)} · {f.folderPath}
              {f.relPath.includes('/') ? ` › ${f.relPath.split('/').slice(0, -1).join(' › ')}` : ''}
            </span>
          </div>
          {showProblem && f.problem && (
            <div>
              <span aria-hidden="true">⚠ </span>
              {PROBLEM_LABELS[f.problem] ?? f.problem}
              {f.detail ? `: ${f.detail}` : ''}
              {f.at ? <span className="muted"> ({formatDate(f.at)})</span> : null}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
