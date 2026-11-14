import { useCallback, useEffect, useState } from 'react';
import { api, KIND_LABELS, type SeriesSummary, type SeriesView } from '../api.ts';
import { LoadError, Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';
import { SeriesDetails } from './SeriesCard.tsx';

/**
 * The Series page (feature review, step 5): every series with what's owned, read, missing and
 * next, the ones being read first; and one series' full map, with the same actions as a book's
 * Series section (finished or ongoing, read elsewhere, collected editions).
 */

const STATUS_SHORT: Record<SeriesSummary['status'], string> = {
  finished: 'Story finished',
  ongoing: 'Story ongoing',
  unknown: 'Not known if finished',
};

type Filter = 'all' | 'started' | 'missing';

export function Series({ id }: { id?: string }) {
  return id ? <OneSeries key={id} id={id} /> : <AllSeries />;
}

function AllSeries() {
  const [list, setList] = useState<SeriesSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      setList((await api.get<{ series: SeriesSummary[] }>('/api/series')).series);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const started = (s: SeriesSummary) => s.reading + s.read + s.readElsewhere > 0;
  const shown = (list ?? []).filter(
    (s) =>
      (filter === 'all' || (filter === 'started' ? started(s) : s.missing > 0)) &&
      (!q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase())),
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Series</h1>
        <p className="muted hide-narrow">
          Every series in your library: what you own, what you’ve read, what’s missing and what
          comes next.
        </p>
      </div>
      {error && <LoadError message={error} onRetry={() => void load()} />}
      {!list && !error && <p className="muted">Loading…</p>}
      {list && list.length === 0 && (
        <Notice>
          No series yet. Books join a series from their files’ details or a confirmed online match,
          or you can put one in a series on its page.
        </Notice>
      )}
      {list && list.length > 0 && (
        <>
          <div className="filters series-filters">
            <div className="field grow">
              <label htmlFor="series-q">Find a series</label>
              <input id="series-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <fieldset className="segmented">
              <legend>Show</legend>
              {(
                [
                  ['all', `All (${list.length})`],
                  ['started', `Started (${list.filter(started).length})`],
                  ['missing', `With gaps (${list.filter((s) => s.missing > 0).length})`],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className={filter === id ? 'on' : ''}>
                  <input
                    type="radio"
                    name="series-filter"
                    value={id}
                    checked={filter === id}
                    onChange={() => setFilter(id)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
          <p className="muted small" aria-live="polite">
            {shown.length} shown
          </p>
          <ul className="series-index">
            {shown.map((s) => (
              <li key={s.id} className="item-row">
                <div className="item-main">
                  <a
                    className="item-title"
                    href={hrefFor({ view: 'series', id: s.id })}
                    onClick={onLinkClick({ view: 'series', id: s.id })}
                  >
                    {s.name}
                  </a>
                  <div className="muted small">
                    {s.kind ? `${KIND_LABELS[s.kind]} · ` : ''}
                    {STATUS_SHORT[s.status]}
                  </div>
                  <ul className="series-counts" aria-label={`${s.name} at a glance`}>
                    <li>{s.owned} owned</li>
                    <li>{s.read} read</li>
                    {s.reading > 0 && <li>{s.reading} in progress</li>}
                    {s.readElsewhere > 0 && <li>{s.readElsewhere} read elsewhere</li>}
                    {s.missing > 0 && (
                      <li className="warn">
                        <span aria-hidden="true">⚠ </span>
                        {s.missing} missing
                      </li>
                    )}
                    {s.unavailable > 0 && (
                      <li className="warn">
                        <span aria-hidden="true">✕ </span>
                        {s.unavailable} with files missing
                      </li>
                    )}
                  </ul>
                  {s.next && (
                    <div className="small">
                      Next:{' '}
                      <a
                        href={hrefFor({ view: 'item', id: s.next.id })}
                        onClick={onLinkClick({ view: 'item', id: s.next.id })}
                      >
                        {s.next.title}
                      </a>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function OneSeries({ id }: { id: string }) {
  const [s, setS] = useState<SeriesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingPublications, setCheckingPublications] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await api.get<SeriesView>(`/api/series/${encodeURIComponent(id)}`));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (s) document.title = `${s.name} · whatBooksNext`;
  }, [s]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page narrow">
      <a
        className="back"
        href={hrefFor({ view: 'series' })}
        onClick={onLinkClick({ view: 'series' })}
      >
        ← All series
      </a>
      {loadError && !s && <LoadError message={loadError} onRetry={() => void load()} />}
      {!s && !loadError && <p className="muted">Loading…</p>}
      {s && (
        <>
          <div className="page-head">
            <h1>{s.name}</h1>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <section className="card series-card" aria-labelledby="series-order-h">
            <h2 id="series-order-h">Order and gaps</h2>
            <SeriesDetails
              s={s}
              itemId={null}
              position={null}
              act={act}
              checkingPublications={checkingPublications}
              setCheckingPublications={setCheckingPublications}
            />
          </section>
        </>
      )}
    </div>
  );
}
