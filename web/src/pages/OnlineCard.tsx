import { useCallback, useEffect, useState } from 'react';
import { api, EFFORT_LABELS, formatRange, type Candidate, type ItemOnline } from '../api.ts';
import { Notice } from '../components.tsx';
import { CandidateRow } from './Review.tsx';

/**
 * An item's online identity and the facts that drive its ranking (PLAN.md §11.2, §12): which
 * match is used and how sure it is, the community rating with its source and scope, the length
 * estimate with its basis, and effort. Owner actions: confirm, not this one, search, leave
 * unidentified, look up again. Text from sources is shown as text only (§6.3).
 */

const IDENTITY_TEXT: Record<ItemOnline['identity'], string> = {
  accepted: 'Matched',
  provisional: 'Probably matched (unconfirmed)',
  tie: 'Two possible matches — pick one below',
  unidentified: 'Not identified online',
};

export function OnlineCard({ itemId, onChanged }: { itemId: string; onChanged: () => void }) {
  const [data, setData] = useState<ItemOnline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<Candidate[] | null>(null);

  const load = useCallback(async () => {
    setData(await api.get<ItemOnline>(`/api/items/${encodeURIComponent(itemId)}/online`));
  }, [itemId]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setResults(null);
      setQuery(null);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const match = (body: object) => run(() => api.post(`/api/items/${itemId}/match`, body));

  if (!data) return null;
  const c = data.community;
  const chosen = data.sources.find((s) => s.chosen)?.chosen ?? null;
  const confirmedKey = data.override && data.override !== 'none' ? data.override : null;

  return (
    <section aria-labelledby="online-h" className="card online-card">
      <h2 id="online-h">Ratings and details</h2>
      <dl className="facts">
        <dt>Identity</dt>
        <dd>
          {data.override === 'none'
            ? 'Left unidentified (your choice)'
            : confirmedKey
              ? 'Matched — confirmed by you'
              : IDENTITY_TEXT[data.identity]}
          {chosen && (
            <>
              {': '}
              <strong>{chosen.title}</strong>
              {chosen.authors.length > 0 && ` by ${chosen.authors.join(', ')}`} (
              {chosen.sourceLabel})
            </>
          )}
        </dd>
        <dt>Community rating</dt>
        <dd>
          {c
            ? `${c.raw}/${c.scale}${c.votes !== null ? ` from ${c.votes.toLocaleString()} ratings` : ' · number of ratings unknown'} on ${data.sources.find((s) => s.source === c.source)?.sourceLabel ?? c.source}${c.scope === 'series' ? ' — for the whole series' : ''}${c.highlyRated ? ' · highly rated there' : ''}`
            : 'Unknown'}
          {c?.label && <div className="muted small">{c.label}</div>}
          {c?.match === 'provisional' && (
            <a href="#possible-matches" onClick={() => setShowMatches(true)}>
              Check and confirm this match
            </a>
          )}
        </dd>
        <dt>Length</dt>
        <dd>
          {data.duration
            ? `${formatRange(data.duration)} (${data.duration.basis}${data.duration.measured ? '' : '; rough'})`
            : 'Unknown'}
        </dd>
        <dt>Effort</dt>
        <dd>
          {EFFORT_LABELS[data.effort]}
          {data.effort !== 'unknown' && <span className="muted"> (rough, from its kind)</span>}
        </dd>
        <dt>First published</dt>
        <dd>
          {data.firstPublishYear ?? 'Unknown'}
          {data.details.firstPublishYear && (
            <span className="muted small"> — {data.details.firstPublishYear.label}</span>
          )}
          {data.details.yearDisagreement && (
            <div className="muted small">
              Sources disagree:{' '}
              {data.details.years.map((y) => `${y.value} (${y.label})`).join('; ')}
            </div>
          )}
        </dd>
        <dt>Pages</dt>
        <dd>
          {data.details.pages
            ? `${data.details.pages.value} — ${data.details.pages.label}${data.details.pages.measured ? ' (measured)' : ' (source estimate)'}`
            : 'Unknown'}
        </dd>
        <dt>Acquired</dt>
        <dd>
          {data.acquired?.date
            ? `${data.acquired.date}${data.acquired.basis === 'file_date' ? ' (from the file date)' : data.acquired.basis === 'first_seen' ? ' (when first scanned)' : ''}`
            : 'Unknown'}
        </dd>
        {data.subjects.length > 0 && (
          <>
            <dt>Subjects</dt>
            <dd>
              {data.details.subjects
                .map(
                  (s) => `${s.value} (${[...new Set(s.sources.map((p) => p.label))].join(', ')})`,
                )
                .join('; ')}
            </dd>
          </>
        )}
      </dl>
      {data.description && (
        <details>
          <summary>Description</summary>
          {/* Untrusted text from a source: rendered as text, never HTML (scenario 23). */}
          <p className="muted small">From {data.details.description?.label}</p>
          <p className="description">{data.description}</p>
        </details>
      )}
      {data.eligibleBecause && (
        <p className="muted small">Not recommended right now: {data.eligibleBecause}.</p>
      )}
      {data.card && !data.eligibleBecause && data.card.limitations.length > 0 && (
        <p className="muted small">Its picks note: {data.card.limitations.join(' · ')}.</p>
      )}

      {data.candidates.length > 0 && (
        <details id="possible-matches" open={showMatches || data.identity === 'tie'}>
          <summary>Possible matches ({data.candidates.length})</summary>
          <ul className="plain candidates">
            {data.candidates.map((x) => (
              <CandidateRow
                key={`${x.source}:${x.sourceId}`}
                c={x}
                onConfirm={() =>
                  void match({ action: 'confirm', source: x.source, sourceId: x.sourceId })
                }
                onReject={() =>
                  void match({ action: 'reject', source: x.source, sourceId: x.sourceId })
                }
              />
            ))}
          </ul>
        </details>
      )}
      {results && (
        <ul className="plain candidates" aria-label="Search results">
          {results.length === 0 && <li className="muted">Nothing found.</li>}
          {results.map((x) => (
            <CandidateRow
              key={`${x.source}:${x.sourceId}`}
              c={x}
              onConfirm={() =>
                void match({ action: 'confirm', source: x.source, sourceId: x.sourceId })
              }
            />
          ))}
        </ul>
      )}
      {query !== null && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              setBusy(true);
              try {
                const r = await api.post<{ candidates: Candidate[]; errors: string[] }>(
                  `/api/items/${itemId}/search`,
                  { query },
                );
                setResults(r.candidates);
                if (r.errors.length) setError(r.errors.join(' · '));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <label className="visually-hidden" htmlFor="online-q">
            Search online sources
          </label>
          <input id="online-q" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="small" disabled={busy}>
            Search
          </button>
        </form>
      )}
      <div className="row-actions wrap">
        {query === null && (
          <button type="button" className="secondary small" onClick={() => setQuery('')}>
            Search for the right book…
          </button>
        )}
        {data.lookupAvailable && (
          <button
            type="button"
            className="secondary small"
            disabled={busy}
            onClick={() => void run(() => api.post(`/api/items/${itemId}/lookup`, {}))}
          >
            Look up again
          </button>
        )}
        {data.override !== 'none' && (
          <button
            type="button"
            className="secondary small"
            disabled={busy}
            onClick={() => void match({ action: 'none' })}
          >
            Leave unidentified
          </button>
        )}
        {data.override && (
          <button
            type="button"
            className="link-button small"
            disabled={busy}
            onClick={() => void match({ action: 'reset' })}
          >
            Let the app choose again
          </button>
        )}
      </div>
      {!data.lookupAvailable && data.lookups.length === 0 && (
        <p className="muted small">
          Comics are looked up from Metron and ComicVine, which arrive in a later version.
        </p>
      )}
      {data.lookups.some((l) => l.error) && (
        <p className="small warn">
          {data.lookups
            .filter((l) => l.error)
            .map((l) => `${l.sourceLabel}: ${l.error}`)
            .join(' · ')}
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
