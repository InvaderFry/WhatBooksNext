import { useEffect, useState } from 'react';
import { api } from '../api.ts';

interface Context {
  bundle: string;
  referenceUrl: string;
  title: string;
  author: string;
  isbn: string;
  notes: string;
}
interface Evidence {
  context: Context;
  files: {
    name: string;
    folder: string;
    pages: { label: string; text: string }[];
    isbns: string[];
  }[];
}

export function IdentificationEvidence({
  itemId,
  onSearch,
}: {
  itemId: string;
  onSearch: (context: Context) => void;
}) {
  const [data, setData] = useState<Evidence | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/items/${encodeURIComponent(itemId)}/identification-context`;
  useEffect(() => {
    let active = true;
    void api
      .get<Evidence>(endpoint)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  const update = (key: keyof Context, value: string) => {
    setData((old) => (old ? { ...old, context: { ...old.context, [key]: value } } : old));
    setSaved(false);
  };
  return (
    <details className="identification-evidence">
      <summary>Identify using bundle details and opening pages</summary>
      <p>
        Use your Humble purchase or bundle listing to narrow the choices. Compare the title,
        credits, publisher, edition and comic issue or volume before confirming a match.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading saved evidence…</p>}
      {data && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              setSaved(false);
              void api
                .post(endpoint, data.context)
                .then(() => setSaved(true))
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {(
              [
                ['bundle', 'Bundle name', 200],
                ['referenceUrl', 'Purchase, bundle or publisher link (HTTPS)', 2000],
                ['title', 'Full title, including volume or issue', 200],
                ['author', 'Author or creator', 100],
                ['isbn', 'ISBN from the copyright page', 30],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key} className="identification-field">
                {label}
                <input
                  value={data.context[key]}
                  maxLength={max}
                  onChange={(e) => update(key, e.target.value)}
                />
              </label>
            ))}
            <label className="identification-field">
              Evidence and edition notes
              <textarea
                value={data.context.notes}
                maxLength={4000}
                rows={3}
                placeholder="Publisher, year, collected issues, or why this is the right book. Record any edition uncertainty."
                onChange={(e) => update('notes', e.target.value)}
              />
            </label>
            <p className="small muted">
              These notes stay local and are included in backups. Search uses only the title, author
              and ISBN. Saving evidence does not confirm a match.
            </p>
            <div className="row-actions wrap">
              <button disabled={busy} type="submit">
                {busy ? 'Saving…' : 'Save evidence'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || (!data.context.title.trim() && !data.context.isbn.trim())}
                onClick={() => onSearch(data.context)}
              >
                Use these details in search
              </button>
            </div>
            {saved && <p role="status">Evidence saved.</p>}
          </form>
          <p className="small muted">
            Opening text is stored locally after a scan. Copy a distinctive phrase to search a
            publisher’s preview if the catalog has no match. Printed ISBNs may refer to another
            edition or another book.
          </p>
          {data.files.map((file, i) => (
            <details key={`${file.name}-${i}`}>
              <summary>{file.name}</summary>
              <p className="small">Folder: {file.folder || '(root)'}</p>
              {file.isbns.length > 0 && (
                <p>
                  ISBN clues:{' '}
                  {file.isbns.map((isbn) => (
                    <button
                      type="button"
                      className="link-button small"
                      key={isbn}
                      onClick={() => update('isbn', isbn)}
                    >
                      {isbn}
                    </button>
                  ))}
                </p>
              )}
              {file.pages.length === 0 && (
                <p>
                  No opening text is cached. Scan again to extract it. Image-only pages need visual
                  inspection; automatic OCR is not available.
                </p>
              )}
              {file.pages.map((page, j) => (
                <details key={j}>
                  <summary>{page.label}</summary>
                  <p className="opening-text">{page.text}</p>
                </details>
              ))}
            </details>
          ))}
          {data.files.length === 0 && <p>No local files are attached to this book.</p>}
        </>
      )}
    </details>
  );
}
