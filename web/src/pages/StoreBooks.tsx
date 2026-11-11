import { useCallback, useEffect, useState } from 'react';
import { api, KIND_LABELS, STORE_LABELS } from '../api.ts';
import { Notice, storeLinkText } from '../components.tsx';
import { navigate } from '../url.ts';

/**
 * Books owned in a store app (PLAN.md §14): add by search or by hand, where each book can be
 * read, and the store CSV import with a preview. A store copy can carry a link to read it there
 * ("Read in Kindle ↗"; Store links in docs/plans/get-store-purchase-imports.md).
 */

export { STORE_LABELS };

/** Where to copy a link from, per store. Apple Books has no web reader, so it takes none. */
const LINK_HELP: Record<string, string> = {
  kindle:
    'Open the book in Kindle’s web reader (read.amazon.com) or on its Amazon page, then copy the address from your browser.',
  google_play:
    'Open the book in Google Play Books (play.google.com/books) or on its Play store page, then copy the address.',
  kobo: 'Open the book on kobo.com (My Books, or its store page), then copy the address.',
  globalcomix: 'Open the comic on globalcomix.com, then copy the address.',
  other: 'Any secure (https) link. Its site is shown next to it, so you can see where it goes.',
};

function StoreSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.entries(STORE_LABELS).map(([k, v]) => (
        <option key={k} value={k}>
          {v}
        </option>
      ))}
    </select>
  );
}

const READABLE_HELP =
  'Tick it if you can open it there now (on your iPhone or iPad). Only then does “Ready to read” include it.';

/** Library → Add a store book: search the online sources, or type it in. */
export function AddStoreBook({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'search' | 'type'>('search');
  const [store, setStore] = useState('kindle');
  const [readable, setReadable] = useState(false);
  const [url, setUrl] = useState('');
  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('');
  const [found, setFound] = useState<{
    token: string;
    errors: string[];
    results: {
      index: number;
      source: string;
      title: string;
      authors: string[];
      year: number | null;
    }[];
  } | null>(null);
  const [f, setF] = useState({ title: '', author: '', kind: '', isbn: '', series: '', number: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (body: object) => {
    setError(null);
    try {
      const r = await api.post<{ itemId: string; joined: boolean }>('/api/store/items', {
        store,
        readable,
        ...(store !== 'apple_books' && url.trim() ? { url: url.trim() } : {}),
        ...body,
      });
      navigate({ view: 'item', id: r.itemId });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card series-card" aria-labelledby="add-store-h">
      <h2 id="add-store-h">Add a book you own in a store app</h2>
      <div className="row-actions wrap">
        <div className="field inline">
          <label htmlFor="store-pick">Where</label>
          <StoreSelect id="store-pick" value={store} onChange={setStore} />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={readable}
            onChange={(e) => setReadable(e.target.checked)}
          />
          I can read it there now
        </label>
      </div>
      <p className="muted small">{READABLE_HELP}</p>
      {store === 'apple_books' ? (
        <p className="muted small">
          Apple Books has no web reader, so its books don’t take a link. Read them in the Books app
          on your iPhone or iPad.
        </p>
      ) : (
        <div className="field">
          <label htmlFor="store-url">Link to read it there (optional)</label>
          <input
            id="store-url"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="muted small">{LINK_HELP[store]}</p>
        </div>
      )}
      <div className="row-actions" role="group" aria-label="How to add it">
        <button
          type="button"
          className={`small ${mode === 'search' ? '' : 'secondary'}`}
          aria-pressed={mode === 'search'}
          onClick={() => setMode('search')}
        >
          Find it online
        </button>
        <button
          type="button"
          className={`small ${mode === 'type' ? '' : 'secondary'}`}
          aria-pressed={mode === 'type'}
          onClick={() => setMode('type')}
        >
          Type it in
        </button>
      </div>
      {mode === 'search' ? (
        <>
          <form
            className="row-actions wrap"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                setFound(await api.post('/api/store/search', { query: q, author }));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="field">
              <label htmlFor="store-q">Title</label>
              <input id="store-q" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="store-a">Author (optional)</label>
              <input id="store-a" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <button type="submit" className="small" disabled={busy || q.trim().length < 2}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </form>
          {found && (
            <>
              {found.errors.map((x) => (
                <p key={x} className="small warn">
                  {x}
                </p>
              ))}
              {found.results.length === 0 ? (
                <p className="muted">
                  Nothing found.{' '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setF({ ...f, title: q, author });
                      setMode('type');
                    }}
                  >
                    Type it in instead
                  </button>
                </p>
              ) : (
                <ul className="plain-list">
                  {found.results.map((r) => (
                    <li key={r.index}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void add({ pick: { token: found.token, index: r.index } })}
                      >
                        {r.title}
                      </button>{' '}
                      <span className="muted small">
                        {[r.authors.join(', '), r.year, r.source].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : (
        <form
          className="series-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void add({ ...f, kind: f.kind || null });
          }}
        >
          {(
            [
              ['title', 'Title'],
              ['author', 'Author (optional)'],
              ['isbn', 'ISBN (optional)'],
              ['series', 'Series (optional)'],
              ['number', 'Number in the series (optional)'],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="field">
              <label htmlFor={`sf-${k}`}>{label}</label>
              <input
                id={`sf-${k}`}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="sf-kind">Kind</label>
            <select
              id="sf-kind"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value })}
            >
              <option value="">Not sure</option>
              {Object.entries(KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="row-actions">
            <button type="submit" className="small" disabled={!f.title.trim()}>
              Add
            </button>
          </div>
        </form>
      )}
      <p>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}

interface Place {
  id: string;
  kind: 'store' | 'history';
  store: string | null;
  readable: boolean;
  note: string | null;
  url: string | null;
  urlKind: 'read' | 'page' | null;
  urlHost: string | null;
  /** The owner typed, changed or removed the link: imports leave it alone. */
  urlByOwner: boolean;
}

/** Add link / Change link: a small form; the server checks the link and says plainly if not. */
function LinkEditor({
  place,
  onSave,
  onCancel,
}: {
  place: Place;
  onSave: (url: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(place.url ?? '');
  const id = `link-${place.id}`;
  return (
    <form
      className="row-actions wrap link-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(value.trim());
      }}
    >
      <div className="field">
        <label htmlFor={id}>Link for {STORE_LABELS[place.store ?? 'other']}</label>
        <input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="muted small">{LINK_HELP[place.store ?? 'other']}</p>
      </div>
      <button type="submit" className="small" disabled={!value.trim()}>
        Save link
      </button>
      <button type="button" className="small secondary" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Item page → Where you can read it: stores (with "I can read it there now") and removal. */
export function PlacesSection({
  itemId,
  hasFiles,
  onChanged,
}: {
  itemId: string;
  hasFiles: boolean;
  onChanged: () => void;
}) {
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [store, setStore] = useState('kindle');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async () => setPlaces(await api.get(`/api/items/${itemId}/locations`)),
    [itemId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      setError(null);
      await fn();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  if (!places) return null;
  const stores = places.filter((p) => p.kind === 'store');
  return (
    <section className="card series-card" aria-labelledby="places-h">
      <h2 id="places-h">In a store app</h2>
      {stores.length === 0 && <p className="muted small">Not recorded in any store app.</p>}
      <ul className="plain-list">
        {stores.map((p) => (
          <li key={p.id} className="row-actions wrap">
            <strong>{STORE_LABELS[p.store ?? 'other']}</strong>
            <label className="check">
              <input
                type="checkbox"
                checked={p.readable}
                onChange={(e) =>
                  void act(() =>
                    api.patch(`/api/locations/${p.id}`, { readable: e.target.checked }),
                  )
                }
              />
              I can read it there now
            </label>
            <button
              type="button"
              className="link-button"
              aria-label={`Remove ${STORE_LABELS[p.store ?? 'other']} from this book`}
              onClick={() => void act(() => api.delete(`/api/locations/${p.id}`))}
            >
              Remove
            </button>
            {p.store !== 'apple_books' && (
              <div className="place-link">
                {p.url ? (
                  <>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={p.urlKind === 'read' ? 'The store’s web reader' : 'Its store page'}
                    >
                      {storeLinkText({ store: p.store ?? 'other', host: p.urlHost ?? '' })}
                      <span aria-hidden="true"> ↗</span>
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>{' '}
                    {p.store !== 'other' && <span className="muted small">{p.urlHost}</span>}{' '}
                    <button
                      type="button"
                      className="link-button small"
                      onClick={() => setEditing(p.id)}
                    >
                      Change link
                    </button>{' '}
                    <button
                      type="button"
                      className="link-button small"
                      onClick={() =>
                        void act(() => api.patch(`/api/locations/${p.id}`, { url: null }))
                      }
                    >
                      Remove link
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="link-button small"
                      onClick={() => setEditing(p.id)}
                    >
                      Add link
                    </button>
                    {p.urlByOwner && (
                      <span className="muted small">
                        {' '}
                        (you removed its link; imports won’t add one back)
                      </span>
                    )}
                  </>
                )}
                {editing === p.id && (
                  <LinkEditor
                    place={p}
                    onCancel={() => setEditing(null)}
                    onSave={async (url) => {
                      if (await act(() => api.patch(`/api/locations/${p.id}`, { url })))
                        setEditing(null);
                    }}
                  />
                )}
              </div>
            )}
            {p.store === 'apple_books' && (
              <span className="muted small">No web reader: read it in the Books app.</span>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row-actions wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api.post(`/api/items/${itemId}/locations`, { store }));
        }}
      >
        <div className="field inline">
          <label htmlFor="place-store">Also in</label>
          <StoreSelect id="place-store" value={store} onChange={setStore} />
        </div>
        <button type="submit" className="small secondary">
          Add
        </button>
      </form>
      {!hasFiles && (
        <p>
          <button
            type="button"
            className="link-button danger"
            onClick={() =>
              void act(async () => {
                if (!window.confirm('Remove this book from your library? Its history goes too.'))
                  return;
                await api.delete(`/api/items/${itemId}`);
                navigate({ view: 'library' });
              })
            }
          >
            Remove this book from the library
          </button>
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}

interface CsvPreviewRow {
  line: number;
  title: string;
  author: string | null;
  store: string;
  outcome: 'already' | 'isbn' | 'possible' | 'new';
  itemId: string | null;
  itemTitle: string | null;
  applies: string[];
  kept: string[];
}

const OUTCOME_TEXT: Record<CsvPreviewRow['outcome'], string> = {
  already: 'Imported before: nothing new',
  isbn: 'Same ISBN as a book you have: the store is added to it',
  possible: 'Same title and author as a book you have',
  new: 'A new book',
};

/** Settings → Store books from a spreadsheet: preview, then import. Repeatable. */
export function CsvImport() {
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<{ rows: CsvPreviewRow[]; problems: string[] } | null>(
    null,
  );
  const [attach, setAttach] = useState<number[]>([]);
  const [keepNew, setKeepNew] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="csv-h" className="section">
      <h2 id="csv-h">Store books from a spreadsheet</h2>
      <p className="muted small">
        A CSV file with a first line naming the columns:{' '}
        <code>
          title, author, store, kind, progress, isbn, series, series_index, rating, note, url
        </code>
        . Only <code>title</code> is needed. <code>store</code> is Kindle, Apple Books, Google Play,
        Kobo or GlobalComix (anything else counts as another app). <code>progress</code> can be
        read, reading or to-read. <code>rating</code> is out of 10, or written like 4/5.{' '}
        <code>url</code> is a link to read it in that store (https, on the store’s own site). You
        see what would happen before anything changes, and importing the same file again adds
        nothing twice and never overwrites your own edits.
      </p>
      <div className="field">
        <label htmlFor="csv-file">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setPreview(null);
            setResult(null);
            setError(null);
            if (!file) return;
            setName(file.name);
            const t = await file.text();
            setText(t);
            try {
              const p = await api.post<{ rows: CsvPreviewRow[]; problems: string[] }>(
                '/api/import/csv/preview',
                { text: t },
              );
              setPreview(p);
              setAttach([]);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </div>
      {preview && text && (
        <>
          <p>
            <strong>{name}</strong>: {preview.rows.length} book
            {preview.rows.length === 1 ? '' : 's'} ·{' '}
            {(['new', 'isbn', 'possible', 'already'] as const)
              .map((o) => [o, preview.rows.filter((r) => r.outcome === o).length] as const)
              .filter(([, n]) => n > 0)
              .map(
                ([o, n]) =>
                  `${n} ${o === 'new' ? 'new' : o === 'isbn' ? 'matched by ISBN' : o === 'possible' ? 'possible matches' : 'imported before'}`,
              )
              .join(' · ')}
          </p>
          {preview.problems.length > 0 && (
            <ul className="small warn">
              {preview.problems.slice(0, 20).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <ul className="plain-list csv-preview">
            {preview.rows.slice(0, 500).map((r) => (
              <li key={r.line}>
                <strong>{r.title}</strong>
                {r.author && ` · ${r.author}`}{' '}
                <span className="muted small">({STORE_LABELS[r.store]})</span>
                <div className="small">
                  {OUTCOME_TEXT[r.outcome]}
                  {r.itemTitle && r.outcome !== 'new' && `: “${r.itemTitle}”`}
                  {r.outcome === 'possible' && (
                    <label className="check inline">
                      <input
                        type="checkbox"
                        checked={attach.includes(r.line)}
                        onChange={(e) =>
                          setAttach(
                            e.target.checked
                              ? [...attach, r.line]
                              : attach.filter((x) => x !== r.line),
                          )
                        }
                      />
                      It’s that book
                    </label>
                  )}
                </div>
                {r.applies.length > 0 && (
                  <div className="small muted">Records: {r.applies.join(', ')}</div>
                )}
                {r.kept.length > 0 && (
                  <div className="small warn">Yours kept — {r.kept.join('; ')}</div>
                )}
              </li>
            ))}
          </ul>
          {preview.rows.length > 500 && <p className="muted small">The first 500 are shown.</p>}
          <label className="check">
            <input
              type="checkbox"
              checked={keepNew}
              onChange={(e) => setKeepNew(e.target.checked)}
            />
            Add books that match nothing (as unconfirmed books; lookups can identify them later)
          </label>
          <div className="row-actions">
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  const r = await api.post<{
                    added: number;
                    attached: number;
                    already: number;
                    skipped: number;
                    links: number;
                  }>('/api/import/csv', { text, attach, keepNew });
                  setResult(
                    `Imported: ${r.added} new, ${r.attached} added to books you have, ${r.already} already there, ${r.skipped} skipped.` +
                      (r.links ? ` ${r.links} link${r.links === 1 ? '' : 's'} added.` : ''),
                  );
                  setPreview(null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Import
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {result && <Notice kind="success">{result}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
