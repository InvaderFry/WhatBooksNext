import type { Adapter } from '../core/adapter.ts';
import { report } from '../core/report.ts';
import { scan } from '../core/scan.ts';

/**
 * The console script's page side: a small panel on the store's page with progress and Cancel,
 * the one-time account notice, then the file download and the title-free report. It talks only
 * to the store's page it runs on, never to whatBooksNext.
 */

const RISK =
  'whatBooksNext will now read your library list on this page, slowly and read-only.\n\n' +
  'Automated reading of a store page may break the store’s terms of use, and a store could ' +
  'challenge or restrict an account that does unusual things. This script goes at about a ' +
  'person’s pace and stops at the first warning or sign-in check.\n\n' +
  'Continue? (Cancel to stop; you can add books by spreadsheet or by hand instead.)';

export async function runInPage(adapter: Adapter): Promise<void> {
  const page = new URL(location.href);
  const where = adapter.checkPage(page);
  if (!where.ok) {
    alert(where.message);
    return;
  }
  if (!confirm(RISK)) return;

  const ctrl = new AbortController();
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'whatBooksNext collector');
  panel.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));' +
    'background:#fff;color:#111;border:2px solid #2e6b57;border-radius:8px;padding:12px;' +
    'font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
  const status = document.createElement('p');
  status.style.margin = '0 0 8px';
  status.setAttribute('aria-live', 'polite');
  status.textContent = `Reading your ${adapter.label} library…`;
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => ctrl.abort();
  panel.append(status, cancel);
  document.body.append(panel);

  const result = await scan(adapter, {
    page,
    fetch: (u, i) => fetch(u, i),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      }),
    now: () => new Date(),
    signal: ctrl.signal,
    onProgress: (p) => {
      status.textContent = `${p.records} books so far, ${p.requests} requests${
        p.waiting ? ' (a longer pause, to go easy on the store)' : ''
      }…`;
    },
  });

  const e = result.envelope;
  const day = e.collectedAt.slice(0, 10);
  const blob = new Blob([JSON.stringify(e, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `whatbooksnext-${adapter.service}-${day}${e.completion.status === 'complete' ? '' : '-' + e.completion.status}.json`;
  document.body.append(a);
  a.click();
  a.remove();

  const text = report(adapter, result, navigator.userAgent);
  console.log(text);
  cancel.remove();
  status.textContent =
    e.completion.status === 'complete'
      ? `Done: ${e.counts.included + e.counts.uncertain} books. The file is in your Downloads folder; keep it private.`
      : `Stopped (${e.completion.status}): ${e.completion.text} The file has what was found so far.`;
  const box = document.createElement('textarea');
  box.readOnly = true;
  box.value = text;
  box.rows = 10;
  box.setAttribute('aria-label', 'Report (no titles)');
  box.style.cssText = 'width:100%;box-sizing:border-box;font:12px monospace;margin:4px 0';
  const copy = document.createElement('button');
  copy.textContent = 'Copy report (no titles)';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      box.select();
    }
  };
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.marginLeft = '8px';
  close.onclick = () => panel.remove();
  panel.append(box, copy, close);
}
