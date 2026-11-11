import { useEffect, useState } from 'react';
import {
  api,
  FORMAT_LABELS,
  KIND_LABELS,
  PROGRESS_LABELS,
  type AppState,
  type Folder,
  type ItemSummary,
} from '../api.ts';
import {
  AvailabilityLabels,
  StoreLinks,
  Cover,
  creatorsText,
  Formats,
  KindText,
  Notice,
} from '../components.tsx';
import { hrefFor, onLinkClick, updateParams, useParams } from '../url.ts';
import { AddFolderForm } from './Settings.tsx';
import { AddStoreBook } from './StoreBooks.tsx';

const PAGE = 100;

const AVAILABILITY_OPTIONS: Record<string, string> = {
  present: 'On this PC',
  not_connected: 'Drive not connected',
  online_only: 'Online only',
  unknown: 'Availability unknown',
  missing: 'File missing',
};

export function Library({
  state,
  onScanStarted,
}: {
  state: AppState | null;
  onScanStarted: () => void;
}) {
  const params = useParams();
  const [adding, setAdding] = useState(false);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.q ?? '');

  const query = new URLSearchParams(
    Object.entries({
      q: params.q,
      kind: params.kind,
      progress: params.progress,
      format: params.format,
      availability: params.availability,
      folder: params.folder,
      ready: params.ready,
      shortlisted: params.shortlisted,
      sort: params.sort,
      dir: params.dir,
    }).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();

  useEffect(() => {
    let stale = false;
    api
      .get<{ total: number; items: ItemSummary[] }>(`/api/items?${query}&limit=${limit}`)
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      stale = true;
    };
  }, [query, limit]);

  useEffect(() => {
    void api.get<Folder[]>('/api/folders').then(setFolders);
  }, []);

  // Debounced search: the URL updates as you type, without filling history.
  useEffect(() => {
    if ((params.q ?? '') === search) return;
    const t = window.setTimeout(() => updateParams({ q: search }), 250);
    return () => window.clearTimeout(t);
  }, [search, params.q]);

  const toggleShortlist = async (item: ItemSummary) => {
    if (item.user.shortlistPosition === null) await api.post('/api/shortlist', { itemId: item.id });
    else await api.delete(`/api/shortlist/${item.id}`);
    setItems(
      (list) =>
        list?.map((i) =>
          i.id === item.id
            ? {
                ...i,
                user: {
                  ...i.user,
                  shortlistPosition: i.user.shortlistPosition === null ? 1 : null,
                },
              }
            : i,
        ) ?? null,
    );
  };

  // The welcome page is only for a truly empty app. After the last folder is removed, books with
  // recorded history are kept (PLAN.md §9.3), so they must stay visible here.
  if (state && state.folders === 0 && state.items === 0) {
    return <FirstRun onScanStarted={onScanStarted} />;
  }
  const noFolders = state?.folders === 0;

  const filtersActive = Boolean(
    params.q ||
    params.kind ||
    params.progress ||
    params.format ||
    params.availability ||
    params.folder ||
    params.ready ||
    params.shortlisted,
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Library</h1>
        <button
          type="button"
          className="small secondary"
          onClick={() => setAdding(!adding)}
          aria-expanded={adding}
        >
          Add a store book…
        </button>
        <p className="muted" aria-live="polite">
          {items === null
            ? 'Loading…'
            : `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'}${filtersActive ? ' match' : ''}`}
        </p>
      </div>

      {adding && <AddStoreBook onClose={() => setAdding(false)} />}

      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field grow">
          <label htmlFor="q">Search titles</label>
          <input
            id="q"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. glass harbor"
          />
        </div>
        <Select
          id="kind"
          label="Kind"
          value={params.kind}
          options={{ ...KIND_LABELS, unknown: 'Unknown' }}
        />
        <Select id="progress" label="Progress" value={params.progress} options={PROGRESS_LABELS} />
        <Select id="format" label="Format" value={params.format} options={FORMAT_LABELS} />
        <Select
          id="availability"
          label="Availability"
          value={params.availability}
          options={AVAILABILITY_OPTIONS}
        />
        {folders.length > 1 && (
          <Select
            id="folder"
            label="Folder"
            value={params.folder}
            options={Object.fromEntries(folders.map((f) => [f.id, f.displayPath]))}
          />
        )}
        <Select
          id="sort"
          label="Sort by"
          value={params.sort}
          allLabel="Title"
          options={{
            added: 'First seen',
            touched: 'Last touched',
            rating: 'Your rating',
            community: 'Online rating',
          }}
        />
        <div className="field">
          <label htmlFor="dir">Order</label>
          <select
            id="dir"
            value={params.dir ?? 'asc'}
            onChange={(e) => updateParams({ dir: e.target.value === 'asc' ? '' : e.target.value })}
          >
            <option value="asc">
              {params.sort && params.sort !== 'title' ? 'Oldest / lowest first' : 'A to Z'}
            </option>
            <option value="desc">
              {params.sort && params.sort !== 'title' ? 'Newest / highest first' : 'Z to A'}
            </option>
          </select>
        </div>
        <div className="checks">
          <label>
            <input
              type="checkbox"
              checked={params.ready === '1'}
              onChange={(e) => updateParams({ ready: e.target.checked ? '1' : '' })}
            />
            Ready to read
          </label>
          <label>
            <input
              type="checkbox"
              checked={params.shortlisted === '1'}
              onChange={(e) => updateParams({ shortlisted: e.target.checked ? '1' : '' })}
            />
            On shortlist
          </label>
        </div>
        {filtersActive && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSearch('');
              updateParams({
                q: '',
                kind: '',
                progress: '',
                format: '',
                availability: '',
                folder: '',
                ready: '',
                shortlisted: '',
              });
            }}
          >
            Clear filters
          </button>
        )}
      </form>
      <p className="hint">
        <strong>Ready to read</strong> keeps books with a file on this PC right now, or marked “Also
        in iCloud”.
      </p>
      {params.sort === 'community' && (
        <p className="hint">
          <strong>Online rating</strong> is adjusted for how many people rated a book, as What next
          does: a 5.0 from 2 ratings doesn’t jump ahead of a 4.3 from 5,000. Books without an online
          rating come last.
        </p>
      )}

      {noFolders && (
        <Notice>
          No library folders are added. The books below are kept because you recorded progress,
          ratings or notes on them.{' '}
          <a href={hrefFor({ view: 'settings' })} onClick={onLinkClick({ view: 'settings' })}>
            Add a folder in Settings
          </a>
          .
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {items && items.length === 0 && (
        <Notice>
          {filtersActive
            ? 'Nothing matches these filters.'
            : 'No books found yet. Scan your folders from Settings.'}
        </Notice>
      )}

      {items && items.length > 0 && (
        <ul className="item-list">
          {items.map((item) => (
            <li key={item.id} className="item-row">
              <Cover fileId={item.coverFileId} kind={item.kind} />
              <div className="item-main">
                <a
                  className="item-title"
                  href={hrefFor({ view: 'item', id: item.id })}
                  onClick={onLinkClick({ view: 'item', id: item.id })}
                >
                  {item.title}
                </a>
                <div className="item-meta">
                  {item.creators.length > 0 && <span>{creatorsText(item.creators)}</span>}
                  <span>
                    <KindText item={item} />
                  </span>
                  <span>
                    <Formats formats={item.formats} />
                  </span>
                  {item.fileCount > item.formats.length && <span>{item.fileCount} files</span>}
                  <span className={`progress progress-${item.user.progress}`}>
                    {PROGRESS_LABELS[item.user.progress]}
                  </span>
                  {item.user.rating !== null && <span>Your rating {item.user.rating}/10</span>}
                  {item.community && (
                    <span>
                      Online {item.community.raw.toFixed(item.community.scale >= 100 ? 0 : 1)}/
                      {item.community.scale}
                      {item.community.votes !== null &&
                        ` from ${item.community.votes.toLocaleString()}`}{' '}
                      ({item.community.sourceLabel}
                      {item.community.scope === 'series' ? ', whole series' : ''}
                      {item.community.unconfirmed ? ', unconfirmed match' : ''})
                    </span>
                  )}
                </div>
                <AvailabilityLabels a={item.availability} />
                {item.availability.storeLinks?.length ? (
                  <div className="row-actions wrap store-links">
                    <StoreLinks a={item.availability} title={item.title} />
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={`star ${item.user.shortlistPosition !== null ? 'on' : ''}`}
                aria-pressed={item.user.shortlistPosition !== null}
                aria-label={`Shortlist ${item.title}`}
                title={
                  item.user.shortlistPosition !== null ? 'On your shortlist' : 'Add to shortlist'
                }
                onClick={() => void toggleShortlist(item)}
              >
                <span aria-hidden="true">{item.user.shortlistPosition !== null ? '★' : '☆'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items && total > items.length && (
        <div className="more">
          <button type="button" className="secondary" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, total - items.length)} more
          </button>
          <span className="muted">
            Showing {items.length.toLocaleString()} of {total.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

function Select({
  id,
  label,
  value,
  options,
  allLabel = 'Any',
}: {
  id: string;
  label: string;
  value: string | undefined;
  options: Record<string, string>;
  allLabel?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => updateParams({ [id]: e.target.value })}>
        <option value="">{allLabel}</option>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
}

function FirstRun({ onScanStarted }: { onScanStarted: () => void }) {
  return (
    <div className="page narrow">
      <h1>Welcome to whatBooksNext</h1>
      <p className="lead">
        Add the folder where your ebooks and comics live. The app lists the files there — it never
        changes, moves or downloads them — and works out what each one is.
      </p>
      <ol className="steps">
        <li>Add a folder (for example your external drive’s Books folder).</li>
        <li>Scan it. A few thousand files take seconds.</li>
        <li>Fix any titles that came out wrong, and mark what you’ve read.</li>
      </ol>
      <AddFolderForm
        autoScan
        onAdded={async () => {
          await api.post('/api/scan', {});
          onScanStarted();
        }}
      />
      <p className="hint">No accounts or API keys needed.</p>
    </div>
  );
}
