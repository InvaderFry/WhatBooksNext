import { useEffect, useState } from 'react';
import { api, type Reminder } from './api.ts';

const PLACE: Record<Reminder['storageKind'], string> = {
  external: 'External drive',
  cloud: 'Cloud folder',
  local: 'Folder',
};

/**
 * The scan reminder (PLAN.md §9.7): a folder whose last complete scan is over 30 days old.
 * Dismiss snoozes it for 7 days. Scans stay manual; this only reminds.
 */
export function ReminderBanner({ onScanStarted }: { onScanStarted: () => void }) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<Reminder[]>('/api/reminders')
      .then(setReminders)
      .catch(() => setReminders([]));
  }, []);
  if (reminders.length === 0) return null;
  return (
    <div className="reminder-banner" role="region" aria-label="Scan reminders">
      {reminders.map((r) => (
        <div key={r.folderId} className="reminder">
          <p>
            <strong>
              {PLACE[r.storageKind]}
              {r.storageKind === 'local' ? ` ${r.displayPath}` : ''}:
            </strong>{' '}
            {r.neverCompleted
              ? `no complete scan since it was added ${r.days} days ago.`
              : `last complete scan ${r.days} days ago.`}{' '}
            {r.storageKind === 'external' ? 'Plug it in and scan.' : 'Scan it to catch up.'}
            {r.storageKind !== 'local' && <span className="muted small"> ({r.displayPath})</span>}
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="small"
              onClick={async () => {
                setError(null);
                try {
                  await api.post('/api/scan', { folderIds: [r.folderId] });
                  setReminders((x) => x.filter((y) => y.folderId !== r.folderId));
                  onScanStarted();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Scan now
            </button>
            <button
              type="button"
              className="secondary small"
              aria-label={`Remind me in a week about ${r.displayPath}`}
              onClick={async () => {
                await api.post(`/api/folders/${r.folderId}/snooze-reminder`);
                setReminders((x) => x.filter((y) => y.folderId !== r.folderId));
              }}
            >
              Remind me in a week
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="small">
          {error}
        </p>
      )}
    </div>
  );
}
