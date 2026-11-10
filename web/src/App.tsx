import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppState, type ScanStatus } from './api.ts';
import { Diagnostics } from './pages/Diagnostics.tsx';
import { Health } from './pages/Health.tsx';
import { Review } from './pages/Review.tsx';
import { ReminderBanner } from './ReminderBanner.tsx';
import { ItemPage } from './pages/ItemPage.tsx';
import { Library } from './pages/Library.tsx';
import { Settings } from './pages/Settings.tsx';
import { Shortlist } from './pages/Shortlist.tsx';
import { Triage } from './pages/Triage.tsx';
import { Tune } from './pages/Tune.tsx';
import { WhatNext } from './pages/WhatNext.tsx';
import { ScanProgress } from './ScanProgress.tsx';
import { hrefFor, onLinkClick, useParams } from './url.ts';

const NAV = [
  { view: 'next', label: 'What next' },
  { view: 'library', label: 'Library' },
  { view: 'triage', label: 'Triage' },
  { view: 'shortlist', label: 'Shortlist' },
  { view: 'review', label: 'Needs review' },
  { view: 'settings', label: 'Settings' },
  { view: 'diagnostics', label: 'Diagnostics' },
] as const;

export function App() {
  const params = useParams();
  const [state, setState] = useState<AppState | null>(null);
  // Home is What next once there is a library; before that, the Library's welcome page.
  const view = params.view ?? (state && state.folders === 0 ? 'library' : 'next');
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

  // Poll the scan while one is running. A finished run the page hasn't seen yet means the
  // library changed — even if the scan finished before the first poll (small folders do).
  const [scanNonce, setScanNonce] = useState(0);
  const lastFinishedRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      const s = (await api.get<{ status: ScanStatus | null }>('/api/scan')).status;
      if (cancelled) return;
      setScan(s);
      if (s?.status === 'running') {
        timer = window.setTimeout(tick, 700);
        return;
      }
      const finished = s?.runId ?? null;
      if (lastFinishedRun.current !== undefined && finished !== lastFinishedRun.current)
        libraryChanged();
      lastFinishedRun.current = finished;
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scanNonce, libraryChanged]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    const titles: Record<string, string> = {
      next: 'What next',
      triage: 'Triage',
      library: 'Library',
      shortlist: 'Shortlist',
      settings: 'Settings',
      diagnostics: 'Diagnostics',
      review: 'Needs review',
      health: 'Library health',
      tune: 'Tune',
      item: 'Book',
    };
    document.title = `${titles[view] ?? 'What next'} · whatBooksNext`;
  }, [view]);

  const scanStarted = () => {
    setScanNonce((n) => n + 1);
    void refreshState(); // the first folder was just added: leave the welcome page
  };

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
                      view === n.view ||
                      (view === 'item' && n.view === 'library') ||
                      (view === 'health' && n.view === 'review') ||
                      (view === 'tune' && n.view === 'settings')
                        ? 'page'
                        : undefined
                    }
                  >
                    {n.label}
                    {n.view === 'review' && state && state.reviewOpen > 0 && (
                      <span className="count"> ({state.reviewOpen})</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {scan?.status === 'running' && <ScanProgress scan={scan} />}
      {scan?.status !== 'running' && (
        <ReminderBanner key={dataVersion} onScanStarted={scanStarted} />
      )}
      <main id="main" tabIndex={-1}>
        {view === 'next' && state && (
          <WhatNext key={dataVersion} params={params} onChanged={() => void refreshState()} />
        )}
        {view === 'triage' && (
          <Triage key={dataVersion} params={params} onChanged={() => void refreshState()} />
        )}
        {view === 'library' && (
          <Library key={dataVersion} state={state} onScanStarted={scanStarted} />
        )}
        {view === 'item' && params.id && (
          <ItemPage
            key={`${params.id}-${dataVersion}`}
            id={params.id}
            mergeWith={params.merge}
            splitFiles={params.split}
          />
        )}
        {view === 'shortlist' && <Shortlist key={dataVersion} />}
        {view === 'settings' && (
          <Settings
            dataVersion={dataVersion}
            scan={scan}
            onScanStarted={scanStarted}
            onLibraryChanged={libraryChanged}
          />
        )}
        {view === 'diagnostics' && <Diagnostics key={dataVersion} />}
        {view === 'review' && <Review key={dataVersion} onChanged={() => void refreshState()} />}
        {view === 'health' && <Health key={dataVersion} />}
        {view === 'tune' && <Tune key={dataVersion} />}
      </main>
    </>
  );
}
