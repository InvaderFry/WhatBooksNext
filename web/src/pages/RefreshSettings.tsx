import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, type FreshEstimate, type RefreshStatus } from '../api.ts';
import { Notice } from '../components.tsx';

/**
 * Settings → Online lookups → Keeping ratings up to date (ratings plan stage 4): automatic
 * refresh on/off, its fixed intervals, pause, "Refresh due books now", and "Look up all books
 * again" with a confirmation that says what it keeps and roughly what it costs.
 */
export function RefreshSettings({ onStarted }: { onStarted: () => void }) {
  const [st, setSt] = useState<RefreshStatus | null>(null);
  const [confirming, setConfirming] = useState<FreshEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSt(await api.get<RefreshStatus>('/api/refresh'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  const iv = st.intervals;
  return (
    <div className="card refresh-settings">
      <h3>Keeping ratings up to date</h3>
      {st.demo ? (
        <p className="small muted">The demo never goes online, so nothing is refreshed.</p>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={st.enabled}
              disabled={busy}
              onChange={(e) =>
                void act(() => api.patch('/api/settings/refresh', { enabled: e.target.checked }))
              }
            />
            Ask the sources again now and then, so ratings and details stay current
          </label>
          {iv && (
            <ul className="small">
              <li>Books you’re reading or have shortlisted: every {iv.active} days.</li>
              <li>Books still without a rating many people agree on: every {iv.open} days.</li>
              <li>Everything else: every {iv.settled} days.</li>
            </ul>
          )}
          <p className="small muted">
            A lookup that failed is tried again after 1, 3 and 7 days. It works quietly in small
            batches while the app is open, uses at most a fifth of Hardcover’s and Metron’s daily
            allowance, and waits during scans and lookups. A refresh never switches a match on its
            own: if a source now prefers another record, Needs review asks you.
          </p>
          <p className="small" role="status">
            {st.dueBooks === 0
              ? 'No books are due now.'
              : `${st.dueBooks.toLocaleString()} ${st.dueBooks === 1 ? 'book is' : 'books are'} due now.`}
            {st.paused && ' Paused until you resume (or restart the app).'}
            {st.lastBatch &&
              ` Last batch ${formatDate(st.lastBatch.at)}: ${st.lastBatch.books} ${st.lastBatch.books === 1 ? 'book' : 'books'}, ${st.lastBatch.requests} requests.`}
          </p>
          <div className="row-actions wrap">
            {st.enabled && (
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() =>
                  void act(() => api.patch('/api/settings/refresh', { paused: !st.paused }))
                }
              >
                {st.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            <button
              type="button"
              className="secondary small"
              disabled={busy || st.dueBooks === 0}
              onClick={() =>
                void act(async () => {
                  await api.post('/api/refresh/due', {});
                  onStarted();
                })
              }
            >
              Refresh due books now
            </button>
          </div>

          <h4>Start fresh</h4>
          {st.fresh ? (
            <p className="small" role="status">
              Looking up all books again, started {formatDate(st.fresh.startedAt)}.
              {st.fresh.waitingForTomorrow
                ? ` ${st.fresh.remaining?.toLocaleString() ?? 'Some'} books are left; it carries on tomorrow, when the sources’ daily limits reset.`
                : ' Progress is in the banner above. Stop it there.'}
            </p>
          ) : confirming ? (
            <div className="confirm-box" role="group" aria-labelledby="fresh-confirm-h">
              <p id="fresh-confirm-h">
                <strong>
                  Look up all {confirming.estimate.books.toLocaleString()} books again?
                </strong>
              </p>
              <ul className="small">
                <li>
                  Every source is asked again and the app chooses its matches afresh from the new
                  answers.
                </li>
                <li>
                  Kept: matches you confirmed, records you said were “not this one”, and all your
                  own edits and reading history.
                </li>
                <li>
                  About {confirming.estimate.requests.toLocaleString()} requests, roughly{' '}
                  {confirming.estimate.hours < 1
                    ? 'under an hour'
                    : `${Math.ceil(confirming.estimate.hours)} hours`}
                  {confirming.estimate.days > 1 &&
                    `, spread over ${confirming.estimate.days} days because of daily limits`}
                  . It runs in the background; you can keep using the app, stop it, or close it (it
                  carries on next time).
                </li>
                <li>
                  {confirming.snapshot
                    ? 'A copy of your data is saved first, as before a restore.'
                    : 'No data folder, so no copy is saved first.'}{' '}
                  Each book keeps its old answers until new ones arrive.
                </li>
              </ul>
              <div className="row-actions wrap">
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.post('/api/lookups/fresh', { confirm: true });
                      setConfirming(null);
                      onStarted();
                    }, 'Started. Progress is in the banner above.')
                  }
                >
                  Look up all books again
                </button>
                <button
                  type="button"
                  className="secondary small"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="small muted">
                To start over from scratch: asks every source about every book again, ignoring saved
                answers, and lets the app choose its matches again. Usually not needed.
              </p>
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setConfirming(await api.get<FreshEstimate>('/api/lookups/fresh')),
                  )
                }
              >
                Look up all books again…
              </button>
            </>
          )}
        </>
      )}
      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
