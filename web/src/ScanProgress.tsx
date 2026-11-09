import { useState } from 'react';
import { api, formatDuration, type ScanStatus } from './api.ts';

export function ScanProgress({ scan }: { scan: ScanStatus }) {
  const [cancelling, setCancelling] = useState(false);
  const files = scan.folders.reduce((n, f) => n + f.filesSeen, 0);
  const current = scan.folders.find((f) => f.folderId === scan.currentFolderId);
  const d = scan.deep;
  let text: string;
  if (scan.phase === 'reading' && d) {
    text = `Reading files — ${d.read.toLocaleString()} of ${d.toRead.toLocaleString()}`;
  } else if (scan.phase === 'hashing' && d) {
    text = `Fingerprinting files to recognise moves and copies — ${d.hashed.toLocaleString()} of ${d.toHash.toLocaleString()}`;
  } else if (scan.phase === 'finishing') {
    text = 'Finishing up';
  } else {
    text = `Scanning${current ? ` ${current.displayPath}` : ''} — ${files.toLocaleString()} book files found so far`;
  }
  const estimate =
    d && d.estimateSeconds !== null && (scan.phase === 'reading' || scan.phase === 'hashing')
      ? ` · ${formatDuration(d.estimateSeconds)} left`
      : '';
  return (
    <div className="scan-bar" role="status" aria-live="polite">
      <div className="scan-bar-inner">
        <span className="spinner" aria-hidden="true" />
        <span>
          {text}
          {estimate}
          <span className="muted small"> · You can keep using the app.</span>
        </span>
        <button
          type="button"
          className="secondary small"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            await api.post('/api/scan/cancel');
          }}
        >
          {cancelling ? 'Stopping…' : 'Cancel scan'}
        </button>
      </div>
    </div>
  );
}
