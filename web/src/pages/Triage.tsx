import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PROGRESS_LABELS, type BulkPreview, type TriageList } from '../api.ts';
import { Cover, creatorsText, KindText, Notice } from '../components.tsx';
import { hrefFor, onLinkClick, updateParams, type Params } from '../url.ts';

/**
 * Triage (PLAN.md §13.5): one book at a time — Want / Maybe / Never / Already read, plus Skip
 * and Undo, all with keyboard shortcuts. Offered, never forced: recommendations work without it.
 * Already read needs no rating or date; an unknown date stays unknown.
 */

const SKIP_KEY = 'wbn:triage-skipped';

function skipped(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SKIP_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

type Action = 'want' | 'maybe' | 'never' | 'read' | 'skip';
interface Done {
  id: string;
  title: string;
  action: Action;
}

const ACTIONS: { action: Action; label: string; key: string }[] = [
  { action: 'want', label: 'Want', key: 'w' },
  { action: 'maybe', label: 'Maybe', key: 'm' },
  { action: 'never', label: 'Never', key: 'n' },
  { action: 'read', label: 'Already read', key: 'r' },
  { action: 'skip', label: 'Skip', key: 's' },
];

/** Which books to sort (§13.5): everything, new arrivals, or one library folder. */
function sourceQuery(params: Params): string {
  const source = params.source === 'new' || params.source === 'folder' ? params.source : '';
  const folder = source === 'folder' ? (params.folder ?? '') : '';
  return `${source ? `&source=${source}` : ''}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`;
}

export function Triage({ params, onChanged }: { params: Params; onChanged: () => void }) {
  if (params.bulk === '1') return <BulkTriage params={params} onChanged={onChanged} />;
  return <OneAtATime params={params} onChanged={onChanged} />;
}

function OneAtATime({ params, onChanged }: { params: Params; onChanged: () => void }) {
  const src = sourceQuery(params);
  const [data, setData] = useState<TriageList | null>(null);
  const [history, setHistory] = useState<Done[]>([]);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const skip = skipped().join(',');
    setData(
      await api.get<TriageList>(`/api/triage?limit=1&skip=${encodeURIComponent(skip)}${src}`),
    );
  }, [src]);
  useEffect(() => {
    void load();
  }, [load]);

  const item = data?.items[0];

  const act = useCallback(
    async (action: Action) => {
      if (!item || busy) return;
      setBusy(true);
      setError(null);
      try {
        if (action === 'skip') {
          try {
            sessionStorage.setItem(SKIP_KEY, JSON.stringify([...skipped(), item.id]));
          } catch {
            /* ignore */
          }
        } else if (action === 'read') {
          await api.patch(`/api/items/${item.id}`, {
            progress: 'finished',
            finishedPrecision: 'unknown',
          });
        } else {
          await api.patch(`/api/items/${item.id}`, { triage: action });
        }
        setHistory((h) => [{ id: item.id, title: item.title, action }, ...h].slice(0, 50));
        setAnnounce(`${item.title}: ${ACTIONS.find((a) => a.action === action)!.label}.`);
        await load();
        onChanged();
        heading.current?.focus();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [item, busy, load, onChanged],
  );

  const undo = useCallback(async () => {
    const last = history[0];
    if (!last || busy) return;
    setBusy(true);
    try {
      if (last.action === 'skip') {
        try {
          sessionStorage.setItem(SKIP_KEY, JSON.stringify(skipped().filter((x) => x !== last.id)));
        } catch {
          /* ignore */
        }
      } else if (last.action === 'read') {
        await api.patch(`/api/items/${last.id}`, { progress: 'not_started' });
      } else {
        await api.patch(`/api/items/${last.id}`, { triage: null });
      }
      setHistory((h) => h.slice(1));
      setAnnounce(`Undone: ${last.title}.`);
      // The undone book comes back first, so the owner can decide again.
      const d = await api.get<TriageList>(
        `/api/triage?limit=50&skip=${encodeURIComponent(skipped().join(','))}${src}`,
      );
      const back = d.items.find((i) => i.id === last.id);
      setData({ ...d, items: back ? [back, ...d.items.filter((i) => i.id !== last.id)] : d.items });
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [history, busy, onChanged, src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'u') {
        e.preventDefault();
        void undo();
        return;
      }
      const a = ACTIONS.find((x) => x.key === k);
      if (a) {
        e.preventDefault();
        void act(a.action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, undo]);

  const sessionDone = history.filter((h) => h.action !== 'skip').length;

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Triage</h1>
        <p className="muted">
          Sort a few books to get better picks — Want, Maybe, Never or Already read. Skip anything
          you’re unsure about. It’s optional: recommendations work without it.
        </p>
      </div>
      {data && <SourcePicker data={data} params={params} />}
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data && (
        <p className="muted small">
          {sessionDone > 0 && `${sessionDone} sorted this session · `}
          {data.remaining.toLocaleString()} still to sort
          {sessionDone >= 15 && ' · That’s a good session — stop whenever you like.'}
        </p>
      )}
      {data && !item && (
        <Notice kind="success">
          Nothing left to sort{skipped().length ? ' (apart from the ones you skipped)' : ''}.{' '}
          <a href={hrefFor({ view: 'next' })} onClick={onLinkClick({ view: 'next' })}>
            See what to read next
          </a>
          .
        </Notice>
      )}
      {item && (
        <article className="card triage-card" aria-labelledby="triage-title">
          <Cover fileId={item.coverFileId} kind={item.kind} size="large" />
          <div>
            <h2 id="triage-title" ref={heading} tabIndex={-1}>
              {item.title}
            </h2>
            <p className="item-meta">
              {item.creators.length > 0 && <span>{creatorsText(item.creators)}</span>}
              <span>
                <KindText item={{ kind: item.kind, isReference: false }} />
                {item.kindIsGuess && <span className="muted"> (guessed)</span>}
              </span>
              {item.firstPublishYear && <span>First published {item.firstPublishYear}</span>}
            </p>
            <p className="scope">
              <strong>{item.scope}</strong>
            </p>
            {item.reasons.length > 0 && (
              <ul className="reasons">
                {item.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {item.description && <p className="description">{item.description}</p>}
          </div>
        </article>
      )}
      <div className="triage-actions" role="group" aria-label="Decide">
        {ACTIONS.map((a) => (
          <button
            key={a.action}
            type="button"
            className={
              a.action === 'skip' ? 'secondary' : a.action === 'never' ? 'secondary danger' : ''
            }
            disabled={!item || busy}
            aria-keyshortcuts={a.key.toUpperCase()}
            onClick={() => void act(a.action)}
          >
            {a.label} <kbd aria-hidden="true">{a.key.toUpperCase()}</kbd>
          </button>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={history.length === 0 || busy}
          aria-keyshortcuts="U"
          onClick={() => void undo()}
        >
          Undo{history[0] ? ` (${history[0].title})` : ''} <kbd aria-hidden="true">U</kbd>
        </button>
      </div>
    </div>
  );
}

function SourcePicker({ data, params }: { data: TriageList; params: Params }) {
  const source = data.source;
  return (
    <div className="triage-source">
      <fieldset className="segmented">
        <legend>Sort which books?</legend>
        {(
          [
            ['all', 'Everything'],
            ['new', `New arrivals (${data.newArrivals})`],
            ['folder', 'One folder'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className={source === id ? 'on' : ''}>
            <input
              type="radio"
              name="source"
              value={id}
              checked={source === id}
              onChange={() =>
                updateParams({
                  source: id === 'all' ? '' : id,
                  folder: id === 'folder' ? (params.folder ?? data.folders[0]?.id ?? '') : '',
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {source === 'folder' && (
        <p>
          <label>
            Folder{' '}
            <select
              value={data.folder ?? ''}
              onChange={(e) => updateParams({ folder: e.target.value })}
            >
              {data.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path} ({f.untriaged} to sort)
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      <p className="small">
        {params.bulk === '1' ? (
          <a href={hrefFor({ ...params, bulk: '' })} onClick={onLinkClick({ ...params, bulk: '' })}>
            Sort one at a time
          </a>
        ) : (
          <a
            href={hrefFor({ ...params, view: 'triage', bulk: '1' })}
            onClick={onLinkClick({ ...params, view: 'triage', bulk: '1' })}
          >
            Mark several as Already read or Never at once
          </a>
        )}
      </p>
    </div>
  );
}

/** Bulk Already read / Never on a selection, with a preview first and Undo after (§13.5). */
function BulkTriage({ params, onChanged }: { params: Params; onChanged: () => void }) {
  const src = sourceQuery(params);
  const [data, setData] = useState<TriageList | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // The preview and exactly the books it was made for: applying sends these, never the
  // selection as it is now, so the confirmation always matches what changes.
  const [preview, setPreview] = useState<(BulkPreview & { ids: string[] }) | null>(null);
  const [done, setDone] = useState<{ text: string; undo: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api.get<TriageList>(`/api/triage?limit=500${src}`));
    setChosen(new Set());
    setPreview(null);
  }, [src]);
  useEffect(() => {
    void load();
  }, [load]);

  const ask = async (action: 'read' | 'never') => {
    setError(null);
    const ids = [...chosen];
    try {
      const r = await api.post<{ preview: BulkPreview }>('/api/triage/bulk', { ids, action });
      setPreview({ ...r.preview, ids });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const apply = async () => {
    if (!preview) return;
    const r = await api.post<{ done: number; undo: string }>('/api/triage/bulk', {
      ids: preview.ids,
      action: preview.action,
      preview: false,
    });
    const text = `${r.done} ${r.done === 1 ? 'book' : 'books'} marked ${preview.action === 'read' ? 'Already read' : 'Never'}.`;
    setDone({ text, undo: r.undo });
    setAnnounce(text);
    await load();
    onChanged();
  };
  const undo = async () => {
    if (!done) return;
    const r = await api.post<{ restored: number; skipped: number }>('/api/triage/bulk/undo', {
      undo: done.undo,
    });
    const text = `Undone for ${r.restored} ${r.restored === 1 ? 'book' : 'books'}${r.skipped ? `; ${r.skipped} changed since, so left as they are` : ''}.`;
    setDone(null);
    setAnnounce(text);
    await load();
    onChanged();
  };

  const items = data?.items ?? [];
  const all = items.length > 0 && items.every((i) => chosen.has(i.id));
  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Triage several at once</h1>
        <p className="muted">
          Tick books you’ve already read, or never want suggested, then choose what to do. You see
          what will change before anything does, and can undo it after.
        </p>
      </div>
      {data && <SourcePicker data={data} params={params} />}
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {done && (
        <Notice kind="success">
          {done.text}{' '}
          <button type="button" className="link-button" onClick={() => void undo()}>
            Undo
          </button>
        </Notice>
      )}
      {data && items.length === 0 && <Notice>Nothing left to sort here.</Notice>}
      {items.length > 0 && (
        <>
          <p className="row-actions wrap">
            <label className="check">
              <input
                type="checkbox"
                checked={all}
                onChange={() => {
                  setChosen(all ? new Set() : new Set(items.map((i) => i.id)));
                  setPreview(null);
                }}
              />
              Select all {items.length}
              {data && data.remaining > items.length ? ` shown (of ${data.remaining})` : ''}
            </label>
          </p>
          <ul className="bulk-list" aria-label="Books to sort">
            {items.map((i) => (
              <li key={i.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(i.id)}
                    onChange={() => {
                      const next = new Set(chosen);
                      if (next.has(i.id)) next.delete(i.id);
                      else next.add(i.id);
                      setChosen(next);
                      setPreview(null);
                    }}
                  />
                  {i.title}
                  {i.creators.length > 0 && (
                    <span className="muted small"> · {creatorsText(i.creators)}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <div className="row-actions wrap">
            <button type="button" disabled={chosen.size === 0} onClick={() => void ask('read')}>
              Already read ({chosen.size})
            </button>
            <button
              type="button"
              className="secondary danger"
              disabled={chosen.size === 0}
              onClick={() => void ask('never')}
            >
              Never ({chosen.size})
            </button>
          </div>
        </>
      )}
      {preview && (
        <section className="section digest" aria-labelledby="preview-h">
          <h2 id="preview-h">
            Mark {preview.changes} {preview.changes === 1 ? 'book' : 'books'}{' '}
            {preview.action === 'read' ? 'Already read' : 'Never'}?
          </h2>
          {preview.action === 'read' && (
            <p>Their finish dates stay unknown, so they don’t count toward any year.</p>
          )}
          {preview.already > 0 && <p>{preview.already} already are, and stay as they are.</p>}
          {preview.inProgress.length > 0 && (
            <>
              <p>These have progress recorded, which this replaces:</p>
              <ul>
                {preview.inProgress.map((x) => (
                  <li key={x.id}>
                    {x.title} <span className="muted small">({PROGRESS_LABELS[x.progress]})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.shortlisted.length > 0 && (
            <p>On your shortlist: {preview.shortlisted.map((x) => x.title).join(', ')}.</p>
          )}
          <div className="row-actions wrap">
            <button type="button" onClick={() => void apply()}>
              Yes, mark {preview.changes}
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
