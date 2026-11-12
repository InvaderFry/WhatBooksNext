import { useCallback, useEffect, useRef, useState } from 'react';
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
      <p className="muted small">
        {READABLE_HELP} To bring in a whole store library at once, use Settings → Import store
        purchases.
      </p>
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

// ---- Import store purchases (store purchases plan, "1b") ---------------------------------------

interface Collector {
  service: string;
  state: 'checked' | 'not_checked' | 'not_built';
  checkedOn: string | null;
  page: string | null;
}

interface PurchaseRow {
  key: string;
  title: string;
  author: string | null;
  acquisition: 'purchase' | 'free_claim' | 'uncertain';
  evidence: string;
  outcome: 'already' | 'isbn' | 'possible' | 'new';
  itemTitle: string | null;
  /** The same title and author as an earlier book in this file (often a second edition). */
  sameInFile: string | null;
  applies: string[];
  kept: string[];
}

interface PurchasePreview {
  label: string;
  adapterVersion: string;
  collectedAt: string;
  region: string | null;
  scopeFromFile: boolean;
  completion: { status: 'complete' | 'partial' | 'failed'; reason: string; text: string };
  counts: { seen: number; included: number; uncertain: number; excluded: Record<string, number> };
  rows: PurchaseRow[];
  problems: string[];
  shrink: { before: number; now: number } | null;
  notSeen: number;
}

const EXCLUDED_LABELS: Record<string, string> = {
  sample: 'samples',
  subscription: 'subscription reads',
  loan: 'loans and library borrows',
  personal_document: 'your own documents',
  upload: 'your own uploads',
  other_shelf: 'other shelves',
};

const COLLECTOR_STATE: Record<Collector['state'], string> = {
  checked: 'Checked',
  not_checked: 'Not checked yet: your first run is the test',
  not_built: 'Not available yet',
};

/** Where each store's library is, for the look-around script. A starting point: the owner may
 * need a click or two to reach the list of their own books. */
const LIBRARY_PAGES: Record<string, { url: string; how: string; open: string; then: string }> = {
  // GlobalComix loads the purchases list as its page opens, before a pasted script can watch: so
  // start on its home page and go to the purchases with the site's own menu.
  globalcomix: {
    url: 'https://globalcomix.com',
    how: 'GlobalComix’s home page',
    open: 'Sign in if asked, and stay on the home page for now.',
    then: 'Now use the site’s own menu to go to My Shelf, then Purchases, so the page loads your purchases while the script watches. Scroll to the very bottom, until no more comics load, and click',
  },
};

/**
 * Stores with no script yet (Stage 2): a look-around script reports the library page's structure
 * (never titles or IDs), and the store's script is built from that report.
 */
function LookAroundSteps({ service }: { service: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const lib = LIBRARY_PAGES[service];
  if (!lib) return null;
  return (
    <>
      <p className="small">
        There’s no script for {STORE_LABELS[service]} yet. Until there is, add its books by search,
        by hand or with the spreadsheet above. To help build it, look around its library once:
      </p>
      <ol className="steps">
        <li>
          In Edge or Chrome, open{' '}
          <a href={lib.url} target="_blank" rel="noopener noreferrer">
            {lib.how}
            <span aria-hidden="true"> ↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          . {lib.open}
        </li>
        <li>
          Copy the look-around script:{' '}
          <button
            type="button"
            className="small secondary"
            onClick={async () => {
              try {
                const r = await api.get<{ script: string }>('/api/store-collectors/probe/script');
                await navigator.clipboard.writeText(r.script);
                setCopied('Copied. Now go to the store’s tab.');
              } catch (e) {
                setCopied(`Couldn’t copy: ${(e as Error).message}`);
              }
            }}
          >
            Copy the look-around script
          </button>{' '}
          {copied && (
            <span className="small" role="status">
              {copied}
            </span>
          )}
        </li>
        <li>
          Press <kbd>F12</kbd>, choose <strong>Console</strong>, paste with <kbd>Ctrl</kbd>+
          <kbd>V</kbd> and press <kbd>Enter</kbd> (type <code>allow pasting</code> first if the
          browser asks).
        </li>
        <li>
          {lib.then} <strong>Finish</strong> in the box in the corner.
        </li>
        <li>
          Click <strong>Copy report</strong> and paste it into chat. It holds only the page’s
          structure: no titles, IDs or account details. It only watches what the page loads; it
          makes no requests of its own.
        </li>
      </ol>
    </>
  );
}

/** What differs between stores' script steps. */
const SCRIPT_STEPS: Record<string, { where: string; shown: string; pace: string; file: string }> = {
  kindle: {
    where: 'your Kindle library',
    shown: 'read.amazon.com/kindle-library',
    pace: 'it goes slowly on purpose (about 50 books every 2 seconds)',
    file: 'whatbooksnext-kindle-…json',
  },
  kobo: {
    where: 'your Kobo Books library',
    shown: 'kobo.com/us/en/library/books',
    pace: 'it reads your library a page at a time, slowly (one page of 24 books every 2 seconds); you can leave the page as it is',
    file: 'whatbooksnext-kobo-…json',
  },
  globalcomix: {
    where: 'GlobalComix’s home page',
    shown:
      'globalcomix.com, not your purchases yet: start here so the page loads your list while the script watches',
    pace: 'after clicking OK, use the site’s own menu to go to My Shelf → Purchases, and scroll to the bottom. The script makes no requests of its own: it reads the list the page loads, and finishes by itself once it has all of it (or click Finish)',
    file: 'whatbooksnext-globalcomix-…json',
  },
  google_play: {
    where: 'your Google Play Books purchases',
    shown: 'play.google.com/books?source=purchases, so your own uploads stay out',
    pace: 'it scrolls the page itself, slowly, and reads the book cards; don’t scroll or switch tabs while it runs',
    file: 'whatbooksnext-google_play-…json',
  },
};

/** The steps for one store's console script. Written for someone who has never used one. */
/**
 * A store's bookmark button (owner decision 2026-11-12): dragged to the bookmarks bar once, then
 * clicked on the store's page. React won't render a `javascript:` link, so its address is set after
 * render; a click here does nothing (and the app's own security policy wouldn't run it anyway).
 */
function BookmarkButton({ service, label }: { service: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [mark, setMark] = useState<{ href: string; version: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void api
      .get<{ href: string; version: string }>(`/api/store-collectors/${service}/bookmarklet`)
      .then(setMark)
      .catch(() => setMark(null));
  }, [service]);
  useEffect(() => {
    if (ref.current && mark) ref.current.setAttribute('href', mark.href);
  }, [mark]);
  if (!mark) return null;
  return (
    <span className="bookmark-row">
      <a
        ref={ref}
        className="button small bookmarklet"
        draggable
        title="Drag me to your bookmarks bar"
        onClick={(e) => {
          e.preventDefault();
          setNote('Drag the button to your bookmarks bar; clicking it here does nothing.');
        }}
      >
        whatBooksNext: {label}
      </a>{' '}
      <button
        type="button"
        className="link-button small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(mark.href);
            setNote(
              'Copied. Right-click the bookmarks bar, choose Add Bookmark, name it, and paste this as its address (URL).',
            );
          } catch (err) {
            setNote(`Couldn’t copy: ${(err as Error).message}`);
          }
        }}
      >
        Can’t drag? Copy its address
      </button>{' '}
      <span className="muted small">(script version {mark.version})</span>
      {note && (
        <span className="small" role="status">
          {' '}
          {note}
        </span>
      )}
    </span>
  );
}

/** The steps for one store's script. Written for someone who has never used one. */
function ScriptSteps({ service, page }: { service: string; page: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const label = STORE_LABELS[service] ?? service;
  const t = SCRIPT_STEPS[service];
  if (!t) return null;
  return (
    <>
      <ol className="steps">
        <li>
          Once: show your bookmarks bar (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> in Firefox,
          Chrome and Edge) and drag this button onto it:{' '}
          <BookmarkButton service={service} label={label} /> When whatBooksNext is updated, drag it
          again, so your bookmark has the newest version.
        </li>
        <li>
          Open{' '}
          <a href={page} target="_blank" rel="noopener noreferrer">
            {t.where}
            <span aria-hidden="true"> ↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>{' '}
          ({t.shown}) and sign in if asked.
        </li>
        <li>
          Click the <strong>whatBooksNext: {label}</strong> bookmark. Read the notice and click{' '}
          <strong>OK</strong>. Leave the tab open: {t.pace}. It shows its progress in the corner.
        </li>
        <li>
          When it’s done, a file called <code>{t.file}</code> is in your Downloads folder. Keep it
          private. If you’re asked for the report, click <strong>Copy report (no titles)</strong>{' '}
          and paste it into chat.
        </li>
        <li>Choose that file below.</li>
      </ol>
      <details className="small">
        <summary>Or paste the script into the browser’s console instead</summary>
        <p>
          <button
            type="button"
            className="small secondary"
            onClick={async () => {
              try {
                const r = await api.get<{ script: string }>(
                  `/api/store-collectors/${service}/script`,
                );
                await navigator.clipboard.writeText(r.script);
                setCopied(`Copied. Now go to the ${label} tab.`);
              } catch (e) {
                setCopied(`Couldn’t copy: ${(e as Error).message}`);
              }
            }}
          >
            Copy the {label} script
          </button>{' '}
          {copied && <span role="status">{copied}</span>}
        </p>
        <p>
          On the {label} tab, press <kbd>F12</kbd> and choose the <strong>Console</strong> tab.
          Paste with <kbd>Ctrl</kbd>+<kbd>V</kbd> and press <kbd>Enter</kbd> (if the browser warns
          about pasting, type <code>allow pasting</code> first). Then carry on from step 3.
        </p>
      </details>
    </>
  );
}

/** Settings → Import store purchases: steps per store, then the file, a preview and Import. */
export function StorePurchaseImport({ onChanged }: { onChanged?: () => void }) {
  const [collectors, setCollectors] = useState<Collector[] | null>(null);
  const [service, setService] = useState('kindle');
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [onlyAccount, setOnlyAccount] = useState(true);
  const [accountName, setAccountName] = useState('');
  const [attach, setAttach] = useState<string[]>([]);
  const [uncertain, setUncertain] = useState<string[]>([]);
  const [keepNew, setKeepNew] = useState(true);
  const [confirmShrink, setConfirmShrink] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<Collector[]>('/api/store-collectors')
      .then(setCollectors)
      .catch(() => setCollectors([]));
  }, []);

  const account = () => (onlyAccount ? null : accountName.trim() || null);
  const load = async (t: string) => {
    setError(null);
    try {
      const p = await api.post<PurchasePreview>('/api/import/store-purchases/preview', {
        text: t,
        accountName: account(),
      });
      setPreview(p);
      setAttach([]);
      setUncertain([]);
      setConfirmShrink(false);
    } catch (err) {
      setPreview(null);
      setError((err as Error).message);
    }
  };

  const chosen = collectors?.find((c) => c.service === service);
  const rows = preview?.rows ?? [];
  const sure = rows.filter((r) => r.acquisition !== 'uncertain');
  const unsure = rows.filter((r) => r.acquisition === 'uncertain' && r.outcome !== 'already');
  const excluded = Object.entries(preview?.counts.excluded ?? {}).filter(([, n]) => n > 0);

  return (
    <section aria-labelledby="purchases-h" className="section">
      <h2 id="purchases-h">Import store purchases</h2>
      <p className="muted small">
        Bring in the books you own at a store, using a small script you run yourself on the store’s
        own website, in your own browser, while signed in. It only reads your library list, slowly,
        and stops at the first warning. It never sees your password, and whatBooksNext never
        contacts the store. Run it again whenever you buy more; nothing is added twice. Apple Books
        can’t be read this way (it has no web library): add those books by search, by hand or with
        the spreadsheet above.
      </p>
      <fieldset className="radio-row">
        <legend>Store</legend>
        {(collectors ?? []).map((c) => (
          <label key={c.service}>
            <input
              type="radio"
              name="purchase-store"
              checked={service === c.service}
              onChange={() => setService(c.service)}
            />
            <span className="store-name">{STORE_LABELS[c.service]}</span>{' '}
            <span className="muted small">
              (
              {c.state === 'checked' && c.checkedOn
                ? `Checked on ${c.checkedOn}`
                : COLLECTOR_STATE[c.state]}
              )
            </span>
          </label>
        ))}
      </fieldset>
      {chosen && chosen.state === 'not_built' && <LookAroundSteps service={service} />}
      {chosen && chosen.state !== 'not_built' && chosen.page && (
        <>
          <p className="small warn">
            Reading a store page with a script may break the store’s terms of use, and a store could
            challenge or restrict an account that does unusual things. The script keeps close to a
            person scrolling their own library. If you’d rather not, use the spreadsheet or add
            books by hand.
          </p>
          <ScriptSteps service={service} page={chosen.page} />
        </>
      )}
      {chosen && chosen.state !== 'not_built' && (
        <div className="field">
          <label htmlFor="purchases-file">The file the script downloaded</label>
          <input
            id="purchases-file"
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setPreview(null);
              setResult(null);
              setError(null);
              if (!file) return;
              setName(file.name);
              const t = await file.text();
              setText(t);
              await load(t);
            }}
          />
        </div>
      )}
      {preview && text && (
        <>
          <p>
            <strong>{name}</strong>: {preview.label}, made {formatWhen(preview.collectedAt)} by
            collector version {preview.adapterVersion}
            {preview.region ? ` on ${preview.region}` : ''}.
          </p>
          {preview.completion.status === 'complete' ? (
            <p className="small ok">The scan finished: this is your whole library.</p>
          ) : (
            <Notice kind="error">
              This scan didn’t finish ({preview.completion.status}): {preview.completion.text} You
              can still import what it found; books it didn’t reach are left as they are.
            </Notice>
          )}
          <p className="small">
            Found {preview.counts.seen}: {preview.counts.included} owned
            {preview.counts.uncertain ? `, ${preview.counts.uncertain} not sure` : ''}
            {excluded.length > 0 &&
              `. Left out: ${excluded.map(([k, n]) => `${EXCLUDED_LABELS[k] ?? k} ${n}`).join(', ')}`}
            .
          </p>
          {preview.shrink && (
            <div className="notice notice-error" role="alert">
              <p>
                This scan found far fewer books ({preview.shrink.now}) than the last complete one (
                {preview.shrink.before}). The store’s website may have changed. Books it didn’t find
                won’t be flagged unless you say so.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmShrink}
                  onChange={(e) => setConfirmShrink(e.target.checked)}
                />
                The numbers are right: flag the books it didn’t find
              </label>
            </div>
          )}
          {preview.notSeen > 0 && !preview.shrink && (
            <p className="small">
              {preview.notSeen} book{preview.notSeen === 1 ? '' : 's'} from earlier scans weren’t
              found. {preview.notSeen === 1 ? 'It goes' : 'They go'} to Needs review, never deleted.
            </p>
          )}
          {!preview.scopeFromFile && (
            <div className="row-actions wrap">
              <label className="check">
                <input
                  type="checkbox"
                  checked={onlyAccount}
                  onChange={(e) => {
                    setOnlyAccount(e.target.checked);
                    if (e.target.checked) void load(text);
                  }}
                />
                This is my only {preview.label} account
              </label>
              {!onlyAccount && (
                <div className="field inline">
                  <label htmlFor="purchase-account">Name for this account</label>
                  <input
                    id="purchase-account"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    onBlur={() => void load(text)}
                  />
                </div>
              )}
            </div>
          )}
          {preview.problems.length > 0 && (
            <ul className="small warn">
              {preview.problems.slice(0, 20).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {unsure.length > 0 && (
            <>
              <h3>Not sure these are yours</h3>
              <p className="muted small">
                The store didn’t say clearly how you got these. Tick the ones you own for good.
              </p>
              <ul className="plain-list csv-preview">
                {unsure.map((r) => (
                  <li key={r.key}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={uncertain.includes(r.key)}
                        onChange={(e) =>
                          setUncertain(
                            e.target.checked
                              ? [...uncertain, r.key]
                              : uncertain.filter((x) => x !== r.key),
                          )
                        }
                      />
                      <strong>{r.title}</strong>
                      {r.author && ` · ${r.author}`}
                    </label>
                    <div className="small muted">The store says: {r.evidence}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Your books</h3>
          <ul className="plain-list csv-preview">
            {[
              ...sure,
              ...rows.filter((r) => r.acquisition === 'uncertain' && r.outcome === 'already'),
            ]
              .slice(0, 500)
              .map((r) => (
                <li key={r.key}>
                  <strong>{r.title}</strong>
                  {r.author && ` · ${r.author}`}
                  <div className="small">
                    {r.sameInFile
                      ? 'Same title and author as another book in this file (another edition?)'
                      : OUTCOME_TEXT[r.outcome]}
                    {r.itemTitle && r.outcome !== 'new' && `: “${r.itemTitle}”`}
                    {r.outcome === 'possible' && (
                      <label className="check inline">
                        <input
                          type="checkbox"
                          checked={attach.includes(r.key)}
                          onChange={(e) =>
                            setAttach(
                              e.target.checked
                                ? [...attach, r.key]
                                : attach.filter((x) => x !== r.key),
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
          {rows.length > 500 && <p className="muted small">The first 500 are shown.</p>}
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
                    notSeen: number;
                  }>('/api/import/store-purchases', {
                    text,
                    attach,
                    uncertain,
                    keepNew,
                    accountName: account(),
                    confirmShrink,
                  });
                  setResult(
                    `Imported: ${r.added} new, ${r.attached} added to books you have, ${r.already} already there, ${r.skipped} skipped` +
                      (r.links ? `, ${r.links} link${r.links === 1 ? '' : 's'} added` : '') +
                      (r.notSeen ? `; ${r.notSeen} not found this time are in Needs review` : '') +
                      '.',
                  );
                  setPreview(null);
                  onChanged?.();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Import selected books
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

const formatWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
