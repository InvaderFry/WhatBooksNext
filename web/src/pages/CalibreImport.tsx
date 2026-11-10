import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Notice } from '../components.tsx';

/**
 * Settings → Calibre (PLAN.md §14): point at a Calibre library, preview, choose what of your own
 * data comes across, import. Only a copy of Calibre's metadata.db is read; Calibre is untouched.
 */

interface Column {
  label: string;
  name: string;
  datatype: string;
}

interface Preview {
  books: number;
  counts: { already: number; files: number; isbn: number; none: number };
  columns: Column[];
  inScannedFolder: boolean;
  rows: {
    title: string;
    authors: string[];
    outcome: 'already' | 'files' | 'isbn' | 'none';
    applies: string[];
    kept: string[];
  }[];
}

const OUTCOME: Record<Preview['rows'][number]['outcome'], string> = {
  already: 'imported before',
  files: 'same file as a book you have',
  isbn: 'same ISBN as a book you have',
  none: 'no file in your library',
};

export function CalibreImport() {
  const [path, setPath] = useState('');
  const [ratings, setRatings] = useState(false);
  const [readColumn, setReadColumn] = useState('');
  const [dateColumn, setDateColumn] = useState('');
  const [keepUnmatched, setKeepUnmatched] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ path: string | null }>('/api/calibre').then((r) => r.path && setPath(r.path));
  }, []);

  const body = () => ({
    path,
    ratings,
    readColumn: readColumn || null,
    dateColumn: dateColumn || null,
    keepUnmatched,
  });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = () =>
    run(async () => {
      setResult(null);
      setPreview(await api.post<Preview>('/api/calibre/preview', body()));
    });

  // Changing what comes across updates the preview.
  useEffect(() => {
    if (preview) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratings, readColumn, dateColumn, keepUnmatched]);

  const readCols = preview?.columns.filter((c) => c.datatype !== 'datetime') ?? [];
  const dateCols = preview?.columns.filter((c) => c.datatype === 'datetime') ?? [];

  return (
    <section aria-labelledby="calibre-h" className="section">
      <h2 id="calibre-h">Calibre</h2>
      <p className="muted small">
        If you keep books in Calibre, its titles, authors, series and ISBNs help identify them here.
        The app copies Calibre’s <code>metadata.db</code> and reads only the copy: nothing in your
        Calibre library is changed. Importing again later adds nothing twice and never overwrites
        what you’ve set here.
      </p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void refresh();
        }}
      >
        <label htmlFor="calibre-path">Calibre library folder</label>
        <input
          id="calibre-path"
          value={path}
          placeholder="e.g. E:\Calibre Library"
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" disabled={busy || !path.trim()}>
          {busy ? 'Reading…' : 'Preview'}
        </button>
      </form>
      <p className="muted small">
        In Calibre, the library folder is the one shown under “Switch/create library”; it holds a
        file called metadata.db. In File Explorer, right-click that folder, choose “Copy as path”,
        and paste it here.
      </p>
      {preview && (
        <div className="card series-card">
          <p>
            <strong>{preview.books.toLocaleString()} books</strong> in Calibre:{' '}
            {(Object.keys(OUTCOME) as (keyof typeof OUTCOME)[])
              .filter((k) => preview.counts[k] > 0)
              .map((k) => `${preview.counts[k].toLocaleString()} ${OUTCOME[k]}`)
              .join(' · ')}
          </p>
          {!preview.inScannedFolder && (
            <p className="small warn">
              This Calibre library isn’t inside a folder you scan, so books can only be matched by
              ISBN. Adding the Calibre library folder in Library folders (above) and scanning it
              matches them by their files.
            </p>
          )}
          <fieldset className="stack">
            <legend>Your own data from Calibre (optional)</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={ratings}
                onChange={(e) => setRatings(e.target.checked)}
              />
              Your Calibre ratings (stars become out of 10; no stars stays unrated)
            </label>
            <div className="field inline">
              <label htmlFor="calibre-read">“Read” column</label>
              <select
                id="calibre-read"
                value={readColumn}
                onChange={(e) => setReadColumn(e.target.value)}
              >
                <option value="">None</option>
                {readCols.map((c) => (
                  <option key={c.label} value={c.label}>
                    {c.name} (#{c.label})
                  </option>
                ))}
              </select>
            </div>
            <div className="field inline">
              <label htmlFor="calibre-date">“Date read” column</label>
              <select
                id="calibre-date"
                value={dateColumn}
                disabled={!readColumn}
                onChange={(e) => setDateColumn(e.target.value)}
              >
                <option value="">None (dates stay unknown)</option>
                {dateCols.map((c) => (
                  <option key={c.label} value={c.label}>
                    {c.name} (#{c.label})
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={keepUnmatched}
                onChange={(e) => setKeepUnmatched(e.target.checked)}
              />
              Also add books that have no file in your library (as unconfirmed books)
            </label>
          </fieldset>
          <ul className="plain-list csv-preview">
            {preview.rows.slice(0, 100).map((r, i) => (
              <li key={i}>
                <strong>{r.title}</strong>
                {r.authors.length > 0 && ` · ${r.authors.join(', ')}`}{' '}
                <span className="muted small">— {OUTCOME[r.outcome]}</span>
                {r.applies.length > 0 && (
                  <div className="small muted">Records: {r.applies.join(', ')}</div>
                )}
                {r.kept.length > 0 && (
                  <div className="small warn">Yours kept — {r.kept.join('; ')}</div>
                )}
              </li>
            ))}
          </ul>
          {preview.rows.length > 100 && <p className="muted small">The first 100 are shown.</p>}
          <div className="row-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.post<{
                    matched: number;
                    added: number;
                    skipped: number;
                    already: number;
                  }>('/api/calibre/import', body());
                  setPreview(null);
                  setResult(
                    `Imported from Calibre: ${r.matched} matched to your books, ${r.already} already there, ${r.added} added, ${r.skipped} skipped.`,
                  );
                })
              }
            >
              Import
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && <Notice kind="success">{result}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
