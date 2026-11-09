import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TriageList } from '../api.ts';
import { Cover, creatorsText, KindText, Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

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

export function Triage({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<TriageList | null>(null);
  const [history, setHistory] = useState<Done[]>([]);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const skip = skipped().join(',');
    setData(await api.get<TriageList>(`/api/triage?limit=1&skip=${encodeURIComponent(skip)}`));
  }, []);
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
        `/api/triage?limit=50&skip=${encodeURIComponent(skipped().join(','))}`,
      );
      const back = d.items.find((i) => i.id === last.id);
      setData({ ...d, items: back ? [back, ...d.items.filter((i) => i.id !== last.id)] : d.items });
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [history, busy, onChanged]);

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
