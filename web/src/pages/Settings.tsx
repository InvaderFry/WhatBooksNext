import { useCallback, useEffect, useId, useState } from 'react';
import { api, daysAgo, formatDate, type Folder, type ScanStatus } from '../api.ts';
import { Notice } from '../components.tsx';
import { CsvImport } from './StoreBooks.tsx';
import { OnlineSettings } from './OnlineSettings.tsx';

export function Settings({
  dataVersion,
  scan,
  onScanStarted,
  onLibraryChanged,
}: {
  /** Bumped when the library changes; reloads folders without remounting (keeps messages). */
  dataVersion: number;
  scan: ScanStatus | null;
  onScanStarted: () => void;
  onLibraryChanged: () => void;
}) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setFolders(await api.get<Folder[]>('/api/folders')), []);
  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const running = scan?.status === 'running';
  const startScan = async (folderIds?: string[]) => {
    setError(null);
    try {
      await api.post('/api/scan', folderIds ? { folderIds } : {});
      onScanStarted();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      {error && <Notice kind="error">{error}</Notice>}

      <section aria-labelledby="folders-h" className="section">
        <div className="section-head">
          <h2 id="folders-h">Library folders</h2>
          <button
            type="button"
            disabled={running || !folders?.length}
            onClick={() => void startScan()}
          >
            {running ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
        <p className="hint">
          Scans only list your files — names, sizes, dates — and never change, move or download
          them. Scans run when you press the button; nothing runs on a schedule.
        </p>
        {folders?.length === 0 && <Notice>No folders yet. Add one below.</Notice>}
        <ul className="folder-list">
          {folders?.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              running={running}
              onScan={() => void startScan([f.id])}
              onChanged={async () => {
                await load();
                onLibraryChanged();
              }}
            />
          ))}
        </ul>
        <AddFolderForm onAdded={load} />
        {scan && scan.status !== 'running' && <LastScan scan={scan} />}
      </section>

      <OnlineSettings />
      <CsvImport />
      <BackupSection onRestored={onLibraryChanged} />
    </div>
  );
}

const STORAGE_LABEL: Record<string, string> = {
  external: 'External drive',
  local: 'This PC',
  cloud: 'Cloud folder',
};

function FolderRow({
  folder: f,
  running,
  onScan,
  onChanged,
}: {
  folder: Folder;
  running: boolean;
  onScan: () => void;
  onChanged: () => Promise<void>;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = daysAgo(f.lastCompleteScanAt);
  const order = ['present', 'placeholder', 'unknown', 'missing'];
  const counts = Object.entries(f.files)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(
      ([k, n]) =>
        `${n.toLocaleString()} ${k === 'present' ? 'here' : k === 'placeholder' ? 'online only' : k}`,
    )
    .join(' · ');
  const id = useId();
  return (
    <li className="folder-row card">
      <div className="folder-main">
        <div className="folder-path">{f.displayPath}</div>
        <div className="small">
          {STORAGE_LABEL[f.storageKind]}
          {f.volumeLabel ? ` “${f.volumeLabel}”` : ''}
          {f.lastLetter ? ` · last seen as ${f.lastLetter}:` : ''} ·{' '}
          {f.reachable ? (
            <span className="ok">✓ Connected</span>
          ) : (
            <span className="warn">⏏ Not connected — skipped by scans, nothing is removed</span>
          )}
        </div>
        <div className="small">
          Last complete scan:{' '}
          {f.lastCompleteScanAt
            ? `${formatDate(f.lastCompleteScanAt)} (${days === 0 ? 'today' : `${days} days ago`})`
            : 'never'}
          {counts && ` · Book files: ${counts}`}
          {f.staleFiles > 0 && ` · ${f.staleFiles} not re-checked last time`}
        </div>
        {f.scanOverdue && f.lastCompleteScanAt && (
          <div className="small warn">
            Over 30 days since a complete scan.{' '}
            {f.storageKind === 'external' ? 'Plug the drive in and scan.' : 'Scan it.'}
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={f.alsoInICloud}
            onChange={async (e) => {
              await api.patch(`/api/folders/${f.id}`, { alsoInICloud: e.target.checked });
              await onChanged();
            }}
          />
          Also in iCloud — I keep copies of these books in iCloud to read on my iPhone/iPad
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        {reconnecting && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const path = new FormData(e.currentTarget).get('path') as string;
              try {
                await api.post(`/api/folders/${f.id}/reconnect`, { path });
                setReconnecting(false);
                await onChanged();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <div className="field grow">
              <label htmlFor={`${id}-path`}>Where is this folder now?</label>
              <input id={`${id}-path`} name="path" placeholder="e.g. F:\Books" required />
            </div>
            <button type="submit">Reconnect</button>
            <button type="button" className="secondary" onClick={() => setReconnecting(false)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="secondary small"
          disabled={running || !f.reachable}
          onClick={onScan}
        >
          Scan this folder
        </button>
        <button type="button" className="secondary small" onClick={() => setReconnecting(true)}>
          Reconnect…
        </button>
        <button
          type="button"
          className="secondary small danger"
          disabled={running}
          onClick={async () => {
            if (
              !window.confirm(
                `Remove ${f.displayPath} from the library?\n\nYour files are not touched. Books you have recorded progress, ratings or notes on stay in the library.`,
              )
            )
              return;
            await api.delete(`/api/folders/${f.id}`);
            await onChanged();
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

export function AddFolderForm({
  onAdded,
  autoScan,
}: {
  onAdded: () => void | Promise<void>;
  autoScan?: boolean;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="inline-form add-folder"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.post('/api/folders', { path });
          setPath('');
          await onAdded();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field grow">
        <label htmlFor="new-folder">Add a folder</label>
        <input
          id="new-folder"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Paste a folder path, e.g. E:\Books"
          aria-describedby="new-folder-help"
          required
        />
        <span id="new-folder-help" className="hint">
          In File Explorer, right-click the folder and choose “Copy as path”, then paste it here.
        </span>
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Adding…' : autoScan ? 'Add and scan' : 'Add folder'}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
    </form>
  );
}

function LastScan({ scan }: { scan: ScanStatus }) {
  const statusText: Record<string, string> = {
    completed: 'Complete',
    partial: 'Partly listed — some folders could not be read; their files were left as they were',
    cancelled: 'Cancelled — unlisted folders were left as they were',
    unreachable: 'Not connected — skipped, nothing removed',
  };
  return (
    <details className="last-scan">
      <summary>
        Last scan: {scan.status === 'completed' ? 'finished' : scan.status}{' '}
        {formatDate(scan.finishedAt)}
        {scan.grouping && ` · ${scan.grouping.itemsCreated} new items`}
        {scan.folders.some((f) => f.reparsed > 0) &&
          ` · ${scan.folders.reduce((n, f) => n + (f.reparsed ?? 0), 0).toLocaleString()} file names re-read with improved rules (your own title fixes are kept)`}
      </summary>
      {scan.error && <Notice kind="error">{scan.error}</Notice>}
      {scan.deep && (
        <p className="small">
          Read {scan.deep.read.toLocaleString()} of {scan.deep.toRead.toLocaleString()} files and
          fingerprinted {scan.deep.hashed.toLocaleString()} of {scan.deep.toHash.toLocaleString()}
          {scan.deep.failed > 0 && ` · ${scan.deep.failed} couldn’t be read (see Library health)`}
          {scan.deep.refused > 0 &&
            ` · ${scan.deep.refused} skipped because they were online-only or had changed when their turn came`}
          {scan.identity &&
            scan.identity.mergedByHash > 0 &&
            ` · ${scan.identity.mergedByHash} recognised as copies or moved files`}
          {scan.identity &&
            scan.identity.split > 0 &&
            ` · ${scan.identity.split} groups split because their files turned out to differ`}
          {scan.identity &&
            scan.identity.reviewAdded > 0 &&
            ` · ${scan.identity.reviewAdded} new questions in Needs review`}
          .
        </p>
      )}
      <table className="table">
        <caption className="visually-hidden">Last scan by folder</caption>
        <thead>
          <tr>
            <th scope="col">Folder</th>
            <th scope="col">Result</th>
            <th scope="col">Book files</th>
            <th scope="col">New</th>
            <th scope="col">Missing</th>
            <th scope="col">Not re-checked</th>
            <th scope="col">Other files ignored</th>
          </tr>
        </thead>
        <tbody>
          {scan.folders.map((f) => (
            <tr key={f.folderId}>
              <td>{f.displayPath}</td>
              <td>{statusText[f.status] ?? f.status}</td>
              <td>{f.filesSeen.toLocaleString()}</td>
              <td>{f.newFiles}</td>
              <td>{f.missing}</td>
              <td>{f.stale}</td>
              <td>
                {Object.entries(f.ignoredByType)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([k, n]) => `${n} .${k}`)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

interface Preview {
  createdAt: string;
  counts: { table: string; inBackup: number; now: number }[];
  changedSinceBackup: number;
}

const TABLE_LABELS: Record<string, string> = {
  items: 'Books and comics',
  files: 'Files',
  folders: 'Folders',
  user_item: 'Your progress, ratings and notes',
  locations: 'Store copies',
  series: 'Series',
};

function BackupSection({ onRestored }: { onRestored: () => void }) {
  const [backup, setBackup] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section aria-labelledby="backup-h" className="section">
      <h2 id="backup-h">Backup and restore</h2>
      <p className="hint">
        A backup holds your library, progress, ratings, notes and settings as one JSON file. It does
        not include your book files, cover images or any API keys.
      </p>
      <a className="button" href="/api/backup" download>
        Download a backup
      </a>

      <div className="restore">
        <div className="field">
          <label htmlFor="restore-file">Restore from a backup file</label>
          <input
            id="restore-file"
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              setError(null);
              setDone(null);
              setPreview(null);
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                // Read in the browser and send as JSON, never as a multipart upload (§6.3).
                const parsed = JSON.parse(await file.text()) as unknown;
                setBackup(parsed);
                setPreview(await api.post<Preview>('/api/restore/preview', { backup: parsed }));
              } catch (err) {
                setError(
                  err instanceof SyntaxError
                    ? "That file isn't valid JSON."
                    : (err as Error).message,
                );
              }
            }}
          />
        </div>
        {preview && (
          <div className="card preview">
            <h3>Restoring replaces everything</h3>
            <p>
              The backup is from {formatDate(preview.createdAt)}. Everything in the app now will be
              replaced by it — nothing is merged. A safety copy of the current data is saved first.
            </p>
            {preview.changedSinceBackup > 0 && (
              <Notice kind="error">
                {preview.changedSinceBackup}{' '}
                {preview.changedSinceBackup === 1 ? 'book has' : 'books have'} progress or notes
                changed since this backup was made. Those changes will be lost.
              </Notice>
            )}
            <table className="table">
              <caption className="visually-hidden">What will be replaced</caption>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Now</th>
                  <th scope="col">After restoring</th>
                </tr>
              </thead>
              <tbody>
                {preview.counts
                  .filter((c) => TABLE_LABELS[c.table])
                  .map((c) => (
                    <tr key={c.table}>
                      <td>{TABLE_LABELS[c.table]}</td>
                      <td>{c.now.toLocaleString()}</td>
                      <td>{c.inBackup.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="row-actions">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.post('/api/restore', { backup, confirm: true });
                    setPreview(null);
                    setDone(
                      'Restored. Your drives don’t need to be connected; the next scan reconnects files.',
                    );
                    onRestored();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Restoring…' : 'Replace everything with this backup'}
              </button>
              <button type="button" className="secondary" onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        {done && <Notice kind="success">{done}</Notice>}
      </div>
    </section>
  );
}
