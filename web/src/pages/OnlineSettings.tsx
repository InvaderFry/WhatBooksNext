import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, type Lookups } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';
import { LookupBanner } from './LookupBanner.tsx';

/**
 * Settings → Online lookups (PLAN.md §12.1, §6.3). Open Library and AniList need no key.
 * Hardcover is optional: the token is stored on this PC only, shown masked with a Show button,
 * and never put in a backup, an export or the Diagnostics report.
 */
export function OnlineSettings() {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [hc, setHc] = useState<{
    configured: boolean;
    masked: string | null;
    newTokenUrl: string;
  } | null>(null);
  const [token, setToken] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLookups(await api.get<Lookups>('/api/lookups'));
    setHc(await api.get('/api/settings/hardcover'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveToken = async (value: string | null) => {
    setError(null);
    try {
      await api.put('/api/settings/hardcover', { token: value });
      setToken('');
      setShown(null);
      setMessage(
        value ? 'Token saved. Run Diagnostics → Test Hardcover to check it.' : 'Token removed.',
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const demo = lookups?.sources.some((s) => s.source === 'demo');

  return (
    <section aria-labelledby="online-settings-h" className="section">
      <h2 id="online-settings-h">Online lookups</h2>
      <p className="muted">
        whatBooksNext looks your books up online for ratings, first publication years, subjects and
        series. Only titles and authors are sent — never files or your reading history.
      </p>
      <LookupBanner always onFinished={() => void load()} onProgress={() => void load()} />
      {lookups && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={lookups.afterScan}
              onChange={async (e) => {
                await api.patch('/api/settings/lookups', { afterScan: e.target.checked });
                await load();
              }}
            />
            Look up new books automatically after each scan
          </label>
          <ul className="folder-list">
            {lookups.sources.map((s) => (
              <li key={s.source} className="card source-row">
                <strong>{s.label}</strong>{' '}
                <span className={s.state === 'paused' ? 'warn' : s.configured ? 'ok' : 'muted'}>
                  {s.state === 'paused'
                    ? '· paused after repeated errors'
                    : s.configured
                      ? '· ready'
                      : '· not set up'}
                </span>
                <div className="muted small">{s.note}</div>
                {s.lastError && (
                  <div className="small warn">
                    Last problem ({formatDate(s.lastErrorAt)}): {s.lastError}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {hc && !demo && (
        <div className="card hardcover">
          <h3>
            Hardcover <span className="tag">Recommended, optional</span>
          </h3>
          <p className="small">
            Hardcover adds book ratings with vote counts, series order and genres. It needs a free
            account and a personal token. Everything works without it.
          </p>
          <ol className="steps small">
            <li>Make a free account at hardcover.app (about 5 minutes), if you don’t have one.</li>
            <li>
              <a href={hc.newTokenUrl} target="_blank" rel="noreferrer noopener">
                Create a token on Hardcover
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>{' '}
              — the link ticks only “read catalog”, which is all this app needs. Copy the token.
            </li>
            <li>Paste it below and press Save. It stays on this PC.</li>
            <li>
              Then open{' '}
              <a
                href={hrefFor({ view: 'diagnostics' })}
                onClick={onLinkClick({ view: 'diagnostics' })}
              >
                Diagnostics
              </a>{' '}
              and press Test Hardcover.
            </li>
          </ol>
          {hc.configured && (
            <p className="row-actions wrap">
              <span>
                Saved token: <code>{shown ?? hc.masked}</code>
              </span>
              <button
                type="button"
                className="secondary small"
                aria-pressed={shown !== null}
                onClick={async () =>
                  setShown(
                    shown
                      ? null
                      : (await api.get<{ token: string }>('/api/settings/hardcover/reveal')).token,
                  )
                }
              >
                {shown ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="secondary small danger"
                onClick={() => void saveToken(null)}
              >
                Remove
              </button>
            </p>
          )}
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) void saveToken(token);
            }}
          >
            <label htmlFor="hc-token">
              {hc.configured ? 'Replace the token' : 'Hardcover token'}
            </label>
            <input
              id="hc-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit" disabled={!token.trim()}>
              Save
            </button>
          </form>
        </div>
      )}
      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
