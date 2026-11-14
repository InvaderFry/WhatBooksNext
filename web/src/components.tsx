import { useState, type ReactNode } from 'react';
import {
  FORMAT_LABELS,
  KIND_LABELS,
  STORE_LABELS,
  type Availability,
  type ItemSummary,
  type StoreLinkView,
} from './api.ts';

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

/** "Read in Kindle", or "Read in another app (example.com)" so the owner sees where it goes. */
export function storeLinkText(l: Pick<StoreLinkView, 'store' | 'host'>): string {
  return l.store === 'other'
    ? `Read in another app (${l.host})`
    : `Read in ${STORE_LABELS[l.store] ?? l.store}`;
}

/**
 * Read in Kindle ↗ (Store links): a plain link that opens in the owner's own browser, where
 * they're signed in to the store. The server never fetches it. `primary`: the main action,
 * for a book with no file present here (when a file is present, Open comes first).
 */
export function StoreLinks({
  a,
  title,
  primary = false,
}: {
  a: Availability;
  title: string;
  primary?: boolean;
}) {
  const links = a.storeLinks ?? [];
  if (links.length === 0) return null;
  return (
    <>
      {links.map((l, i) => (
        <a
          key={l.url}
          className={`button small store-link${primary && i === 0 ? '' : ' secondary'}`}
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
          title={
            l.kind === 'read'
              ? `Opens it in ${STORE_LABELS[l.store] ?? 'the store'}’s web reader`
              : `Opens its page at ${l.host}`
          }
        >
          {storeLinkText(l)}
          <span aria-hidden="true"> ↗</span>
          <span className="visually-hidden"> ({title}, opens in a new tab)</span>
        </a>
      ))}
    </>
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

/**
 * A page or section that couldn't load: what went wrong and a Retry, never an empty page.
 * Use it wherever the first load fails and there is nothing else to show.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice notice-error load-error" role="alert">
      <p>Couldn’t load this. {message}</p>
      <button type="button" className="secondary small" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * A cover thumbnail, or a plain placeholder. Decorative: the title is always next to it, so the
 * image has empty alt text and screen readers don't hear every title twice.
 */
export function Cover({
  fileId,
  itemId,
  kind,
  size = 'small',
}: {
  fileId: string | null;
  /** A book without a file cover: its own online cover, when it has one. */
  itemId?: string | null;
  kind?: string | null;
  size?: 'small' | 'large';
}) {
  const [failed, setFailed] = useState(false);
  const src = fileId
    ? `/api/files/${encodeURIComponent(fileId)}/thumbnail`
    : itemId
      ? `/api/items/${encodeURIComponent(itemId)}/cover`
      : null;
  if (!src || failed)
    return (
      <span
        className={`cover cover-${size} cover-none`}
        aria-hidden="true"
        data-kind={kind ?? ''}
      />
    );
  return (
    <img
      className={`cover cover-${size}`}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function creatorsText(creators: { name: string; role?: string }[]): string {
  const names = [...new Set(creators.map((c) => c.name))];
  if (names.length <= 2) return names.join(' & ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
