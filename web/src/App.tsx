import { useCallback, useEffect, useState } from 'react';
import { api, type AppState, type ScanStatus } from './api.ts';
import { Diagnostics } from './pages/Diagnostics.tsx';
import { ItemPage } from './pages/ItemPage.tsx';
import { Library } from './pages/Library.tsx';
import { Settings } from './pages/Settings.tsx';
import { Shortlist } from './pages/Shortlist.tsx';
import { ScanProgress } from './ScanProgress.tsx';
import { hrefFor, onLinkClick, useParams } from './url.ts';

const NAV = [
  { view: 'library', label: 'Library' },
  { view: 'shortlist', label: 'Shortlist' },
  { view: 'settings', label: 'Settings' },
  { view: 'diagnostics', label: 'Diagnostics' },
] as const;

export function App() {
  const params = useParams();
  const view = params.view ?? 'library';
  const [state, setState] = useState<AppState | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  const refreshState = useCallback(async () => {
    setState(await api.get<AppState>('/api/state'));
  }, []);

  /** Something changed the library (scan finished, restore, folder removed): reload views. */
  const libraryChanged = useCallback(() => {
    setDataVersion((v) => v + 1);
    void refreshState();
  }, [refreshState]);

  // Poll the scan while one is running; stop when it finishes.
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      const s = (await api.get<{ status: ScanStatus | null }>('/api/scan')).status;
      if (cancelled) return;
      setScan((prev) => {
        if (prev?.status === 'running' && s?.status !== 'running') libraryChanged();
        return s;
      });
      if (s?.status === 'running') timer = window.setTimeout(tick, 700);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [state?.scanRunning, libraryChanged]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    const titles: Record<string, string> = {
      library: 'Library',
      shortlist: 'Shortlist',
      settings: 'Settings',
      diagnostics: 'Diagnostics',
      item: 'Book',
    };
    document.title = `${titles[view] ?? 'Library'} · whatBooksNext`;
  }, [view]);

  const scanStarted = () =>
    void refreshState().then(() => setState((s) => (s ? { ...s, scanRunning: true } : s)));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {state?.demo && (
        <div className="demo-banner" role="note">
          <strong>Demo library.</strong> Every title here is invented. Nothing you do here touches
          your real data.
        </div>
      )}
      <header className="app-header">
        <div className="header-inner">
          <a className="brand" href="/" onClick={onLinkClick({})}>
            <img src="/favicon.svg" alt="" width="24" height="24" />
            whatBooksNext
          </a>
          <nav aria-label="Main">
            <ul>
              {NAV.map((n) => (
                <li key={n.view}>
                  <a
                    href={hrefFor({ view: n.view })}
                    onClick={onLinkClick({ view: n.view })}
                    aria-current={
                      view === n.view || (view === 'item' && n.view === 'library')
                        ? 'page'
                        : undefined
                    }
                  >
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {scan?.status === 'running' && <ScanProgress scan={scan} />}
      <main id="main" tabIndex={-1}>
        {view === 'library' && (
          <Library key={dataVersion} state={state} onScanStarted={scanStarted} />
        )}
        {view === 'item' && params.id && (
          <ItemPage key={`${params.id}-${dataVersion}`} id={params.id} />
        )}
        {view === 'shortlist' && <Shortlist key={dataVersion} />}
        {view === 'settings' && (
          <Settings
            key={dataVersion}
            scan={scan}
            onScanStarted={scanStarted}
            onLibraryChanged={libraryChanged}
          />
        )}
        {view === 'diagnostics' && <Diagnostics key={dataVersion} />}
      </main>
    </>
  );
}
