import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDuration, type Lookups } from '../api.ts';
import { Notice } from '../components.tsx';

/**
 * Online lookups (PLAN.md §12.1): how many books still need one, progress while running, and
 * Start / Cancel. Cancel stops after the current book; the next run carries on (§9.6).
 */
export function LookupBanner({
  onFinished,
  always = false,
}: {
  onFinished?: () => void;
  /** Show even when nothing is pending (Settings). */
  always?: boolean;
}) {
  const [data, setData] = useState<Lookups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  // The latest callback, without making `load` change on every render.
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Lookups>('/api/lookups');
      setData(d);
      const running = d.status?.status === 'running';
      if (wasRunning.current && !running) finished.current?.();
      wasRunning.current = running;
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const running = data?.status?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(t);
  }, [running, load]);

  const start = async () => {
    setError(null);
    try {
      await api.post('/api/lookups', {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data) return null;
  const s = data.status;
  if (!running && data.pending === 0 && !always) return null;

  return (
    <div className="lookup-banner" role="status">
      {running && s ? (
        <>
          <p>
            <span className="spinner" aria-hidden="true" /> Looking up books online: {s.done} of{' '}
            {s.total}
            {s.estimateSeconds !== null && ` · ${formatDuration(s.estimateSeconds)} left`}.
            <span className="muted"> Picks improve as it goes; you can keep using the app.</span>
          </p>
          <button
            type="button"
            className="secondary small"
            onClick={() => void api.post('/api/lookups/cancel').then(load)}
          >
            Stop
          </button>
        </>
      ) : data.pending > 0 ? (
        <>
          <p>
            {data.pending.toLocaleString()} {data.pending === 1 ? 'book hasn’t' : 'books haven’t'}{' '}
            been looked up online yet, so {data.pending === 1 ? 'its' : 'their'} ratings and details
            are missing.{' '}
            <span className="muted">
              Open Library allows about one lookup a second, so a big library takes a while. It runs
              in the background and carries on where it stopped.
            </span>
          </p>
          <button type="button" className="small" onClick={() => void start()}>
            Look them up now
          </button>
        </>
      ) : (
        <p className="muted">
          Every book has been looked up.
          {s?.finishedAt ? ` Last run ${new Date(s.finishedAt).toLocaleString()}.` : ''}
        </p>
      )}
      {s && !running && s.errors.length > 0 && (
        <p className="small warn">Last run’s problems: {s.errors.join(' · ')}</p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
