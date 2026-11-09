import type { ReactNode } from 'react';
import { FORMAT_LABELS, KIND_LABELS, type Availability, type ItemSummary } from './api.ts';

/** Availability shown as text plus an icon — never colour alone (PLAN.md §13.4). */
export function AvailabilityLabels({ a }: { a: Availability }) {
  return (
    <span className="labels">
      {a.label && (
        <span className={`label label-${a.state}`}>
          <span aria-hidden="true">{ICON[a.state] ?? '•'} </span>
          {a.label}
        </span>
      )}
      {a.alsoInICloud && (
        <span className="label label-icloud">
          <span aria-hidden="true">☁ </span>Also in iCloud
        </span>
      )}
    </span>
  );
}

const ICON: Record<string, string> = {
  not_connected: '⏏',
  online_only: '☁',
  unknown: '?',
  missing: '✕',
  store: '▣',
};

export function KindText({ item }: { item: Pick<ItemSummary, 'kind' | 'isReference'> }) {
  return (
    <>
      {item.kind ? KIND_LABELS[item.kind] : <span className="muted">Kind unknown</span>}
      {item.isReference && ' · Reference'}
    </>
  );
}

export function Formats({ formats }: { formats: string[] }) {
  return <>{formats.map((f) => FORMAT_LABELS[f] ?? f.toUpperCase()).join(' · ')}</>;
}

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
