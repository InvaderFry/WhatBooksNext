import { useState } from 'react';
import { api, type ScanStatus } from './api.ts';

export function ScanProgress({ scan }: { scan: ScanStatus }) {
  const [cancelling, setCancelling] = useState(false);
  const files = scan.folders.reduce((n, f) => n + f.filesSeen, 0);
  const current = scan.folders.find((f) => f.folderId === scan.currentFolderId);
  return (
    <div className="scan-bar" role="status" aria-live="polite">
      <div className="scan-bar-inner">
        <span className="spinner" aria-hidden="true" />
        <span>
          Scanning{current ? ` ${current.displayPath}` : ''} — {files.toLocaleString()} book files
          found so far
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
