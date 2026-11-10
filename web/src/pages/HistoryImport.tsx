import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { Notice } from '../components.tsx';

type Source = 'goodreads' | 'storygraph';
interface PreviewRow {
  line: number;
  title: string;
  author: string | null;
  outcome: 'already' | 'isbn' | 'possible' | 'history' | 'skip';
  itemTitle: string | null;
  applies: string[];
  kept: string[];
}
interface Preview {
  rows: PreviewRow[];
  problems: string[];
}
const LABELS = {
  already: 'Imported before: nothing changes',
  isbn: 'ISBN and title or author agree with a book in your library',
  possible: 'Possible match — confirm before attaching history',
  history: 'New history-only entry; never recommended',
  skip: 'No reading status to import; skipped',
};

export function HistoryImport({ onChanged }: { onChanged: () => void }) {
  const [source, setSource] = useState<Source>('goodreads');
  const [text, setText] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [attach, setAttach] = useState<number[]>([]);
  const [keepUnmatched, setKeepUnmatched] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const request = useRef(0);
  const [shown, setShown] = useState(100);

  return (
    <section className="section" aria-labelledby="history-import-h">
      <h2 id="history-import-h">Reading history from Goodreads or StoryGraph</h2>
      <p className="muted small">
        Export your library from Goodreads (My Books → Import and export) or StoryGraph (Manage
        Account → Manage Your Data). Choose that CSV here to preview it. Your own edits are kept,
        and importing the same books again changes nothing. Books you don’t have here become
        history-only entries, never recommendations. Unmatched to-read books are skipped; the export
        doesn’t establish ownership or a place to read.
      </p>
      <p className="muted small">
        Ratings out of 5 are doubled to our 1–10 scale; quarter stars are rounded to the nearest
        whole number, shown in the preview. Missing finish dates stay unknown; a year or month stays
        approximate. Rereads count as one reading, using the last finish date. Reviews and Goodreads
        private notes become your note; other columns are left out.
      </p>
      <div className="field">
        <label htmlFor="history-source">History source</label>
        <select
          id="history-source"
          value={source}
          disabled={busy}
          onChange={(e) => {
            request.current++;
            setSource(e.target.value as Source);
            setText(null);
            setPreview(null);
            setError(null);
            setResult(null);
            setAttach([]);
          }}
        >
          <option value="goodreads">Goodreads</option>
          <option value="storygraph">StoryGraph</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="history-file">Reading history CSV file</label>
        <input
          id="history-file"
          key={source}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            // Let choosing the same file fire change after Cancel, an error or an import.
            e.target.value = '';
            setFilename(file?.name ?? '');
            const version = ++request.current;
            setText(null);
            setPreview(null);
            setResult(null);
            setError(null);
            setAttach([]);
            setShown(100);
            if (!file) return;
            setBusy(true);
            try {
              if (file.size > 20_000_000)
                throw new Error('That file is too large (maximum 20 MB).');
              const t = await file.text();
              const p = await api.post<Preview>('/api/import/history/preview', { source, text: t });
              if (version !== request.current) return;
              setText(t);
              setPreview(p);
            } catch (err) {
              if (version === request.current) setError((err as Error).message);
            } finally {
              if (version === request.current) setBusy(false);
            }
          }}
        />
      </div>
      {busy && <p role="status">Working…</p>}
      {preview && text && (
        <>
          <p>
            <strong>
              {filename}: {preview.rows.length} books in this preview.
            </strong>{' '}
            Nothing has been saved yet.
          </p>
          {preview.problems.length > 0 && (
            <details>
              <summary>{preview.problems.length} import notes</summary>
              <ul className="small warn">
                {preview.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </details>
          )}
          <ul className="plain-list csv-preview">
            {preview.rows.slice(0, shown).map((r) => (
              <li key={r.line}>
                <strong>{r.title}</strong>
                {r.author && ` · ${r.author}`}
                <div className="small">
                  Row {r.line}: {LABELS[r.outcome]}
                  {r.itemTitle && `: “${r.itemTitle}”`}
                </div>
                {r.outcome === 'possible' && (
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={attach.includes(r.line)}
                      onChange={(e) =>
                        setAttach(
                          e.target.checked
                            ? [...attach, r.line]
                            : attach.filter((n) => n !== r.line),
                        )
                      }
                    />
                    Attach this row to that book. Otherwise skip this row.
                  </label>
                )}
                {r.applies.length > 0 && (
                  <div className="small muted">Records: {r.applies.join(', ')}</div>
                )}
                {r.kept.length > 0 && (
                  <div className="small warn">Yours kept — {r.kept.join('; ')}</div>
                )}
              </li>
            ))}
          </ul>
          {shown < preview.rows.length && (
            <button type="button" onClick={() => setShown(shown + 100)}>
              Show more history rows
            </button>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={keepUnmatched}
              disabled={busy}
              onChange={(e) => setKeepUnmatched(e.target.checked)}
            />
            Keep unmatched read, reading and DNF books as history-only entries
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={busy || preview.rows.length === 0}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await api.post<{
                    added: number;
                    attached: number;
                    already: number;
                    skipped: number;
                  }>('/api/import/history', { source, text, attach, keepUnmatched });
                  setResult(
                    `Imported: ${r.added} history entries, ${r.attached} attached to books, ${r.already} imported before, ${r.skipped} skipped.`,
                  );
                  setPreview(null);
                  setText(null);
                  onChanged();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import reading history
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setText(null);
              }}
            >
              Cancel history import
            </button>
          </div>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {result && <Notice>{result}</Notice>}
    </section>
  );
}
