import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDuration, type Lookups } from '../api.ts';
import { Notice } from '../components.tsx';

/**
 * Online lookups (PLAN.md §12.1): how many books still need one, progress while running, and
 * Start / Cancel. Cancel stops after the current book; the next run carries on (§9.6).
 */
export function LookupBanner({
  onFinished,
  onProgress,
  always = false,
}: {
  onFinished?: () => void;
  /** Called on each refresh while lookups run (Settings refreshes its source list). */
  onProgress?: () => void;
  /** Show even when nothing is pending (Settings). */
  always?: boolean;
}) {
  const [data, setData] = useState<Lookups | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The owner pressed a button here: keep showing what that run did, even when it finished
   * at once (answers come from the cache) and nothing is pending any more. Without this the
   * banner looked unchanged, or vanished, and the button seemed to do nothing.
   */
  const [pressed, setPressed] = useState(false);
  const wasRunning = useRef(false);
  // The latest callback, without making `load` change on every render.
  const finished = useRef(onFinished);
  const progress = useRef(onProgress);
  useEffect(() => {
    finished.current = onFinished;
    progress.current = onProgress;
  }, [onFinished, onProgress]);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Lookups>('/api/lookups');
      setData(d);
      const running = d.status?.status === 'running';
      if (running) progress.current?.();
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
    setPressed(true);
    try {
      await api.post('/api/lookups', {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data) return null;
  const s = data.status;
  if (!running && data.pending === 0 && data.pendingSeries === 0 && !always && !pressed)
    return null;
  const outcome =
    pressed && !running && s?.finishedAt
      ? [
          s.total > 0 &&
            `Looked up ${s.done.toLocaleString()} of ${s.total.toLocaleString()} books.`,
          s.series &&
            s.series.total > 0 &&
            `Checked published volumes for ${s.series.done.toLocaleString()} of ${s.series.total.toLocaleString()} series${
              s.errors.length > 0 ? '; the problems are below' : ''
            }.`,
          s.status === 'cancelled' && 'Stopped.',
        ]
          .filter(Boolean)
          .join(' ')
      : null;

  return (
    <div className="lookup-banner" role="status">
      {running && s ? (
        <>
          <p>
            <span className="spinner" aria-hidden="true" />{' '}
            {s.series
              ? `Checking published volumes: ${s.series.done} of ${s.series.total} series`
              : `${s.label === 'fresh' ? 'Looking up all books again' : s.label === 'due' ? 'Refreshing due books' : 'Looking up books online'}: ${s.done} of ${s.total}`}
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
      ) : data.pendingSeries > 0 ? (
        <>
          <p>
            Published volumes need checking for {data.pendingSeries.toLocaleString()} series. This
            checks online sources without rescanning your files.
          </p>
          <button type="button" className="small" onClick={() => void start()}>
            Check published volumes now
          </button>
        </>
      ) : (
        <p className="muted">
          Every book has been looked up.
          {s?.finishedAt ? ` Last run ${new Date(s.finishedAt).toLocaleString()}.` : ''}
        </p>
      )}
      {outcome && (
        <p className="small" role="status">
          ✓ Done. {outcome}
        </p>
      )}
      {s && !running && s.error && <p className="small warn">{s.error}</p>}
      {s && !running && s.errors.length > 0 && (
        <p className="small warn">Last run’s problems: {s.errors.join(' · ')}</p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
