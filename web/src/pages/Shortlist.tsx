import { useCallback, useEffect, useState } from 'react';
import { api, PROGRESS_LABELS, type ItemSummary } from '../api.ts';
import { AvailabilityLabels, Formats, KindText, Notice, StoreLinks } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/** An ordered "next up" queue (PLAN.md §13.9): reorder with accessible ↑/↓ buttons. */
export function Shortlist() {
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [announce, setAnnounce] = useState('');

  const load = useCallback(
    async () => setItems(await api.get<ItemSummary[]>('/api/shortlist')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const move = async (item: ItemSummary, direction: 'up' | 'down', index: number) => {
    await api.post('/api/shortlist/move', { itemId: item.id, direction });
    await load();
    const pos = direction === 'up' ? index : index + 2;
    setAnnounce(`${item.title} moved to position ${pos}.`);
    // Keep focus on the same button so repeated presses keep moving the item.
    window.requestAnimationFrame(() =>
      document.getElementById(`move-${direction}-${item.id}`)?.focus(),
    );
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Shortlist</h1>
        <p className="muted">What you mean to read next, in order.</p>
      </div>
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      {items?.length === 0 && (
        <Notice>
          Nothing on the shortlist yet. Use the ☆ next to any book in the{' '}
          <a href={hrefFor({ view: 'library' })} onClick={onLinkClick({ view: 'library' })}>
            Library
          </a>
          .
        </Notice>
      )}
      {items && items.length > 0 && (
        <ol className="item-list shortlist">
          {items.map((item, i) => (
            <li key={item.id} className="item-row">
              <span className="position" aria-hidden="true">
                {i + 1}
              </span>
              <div className="item-main">
                <a
                  className="item-title"
                  href={hrefFor({ view: 'item', id: item.id })}
                  onClick={onLinkClick({ view: 'item', id: item.id })}
                >
                  {item.title}
                </a>
                <div className="item-meta">
                  <span>
                    <KindText item={item} />
                  </span>
                  <span>
                    <Formats formats={item.formats} />
                  </span>
                  <span>{PROGRESS_LABELS[item.user.progress]}</span>
                </div>
                <AvailabilityLabels a={item.availability} />
                {item.availability.storeLinks?.length ? (
                  <div className="row-actions wrap store-links">
                    <StoreLinks a={item.availability} title={item.title} />
                  </div>
                ) : null}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  id={`move-up-${item.id}`}
                  className="secondary small icon"
                  disabled={i === 0}
                  aria-label={`Move ${item.title} up`}
                  onClick={() => void move(item, 'up', i)}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  id={`move-down-${item.id}`}
                  className="secondary small icon"
                  disabled={i === items.length - 1}
                  aria-label={`Move ${item.title} down`}
                  onClick={() => void move(item, 'down', i)}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className="secondary small"
                  aria-label={`Remove ${item.title} from the shortlist`}
                  onClick={async () => {
                    await api.delete(`/api/shortlist/${item.id}`);
                    setAnnounce(`${item.title} removed from the shortlist.`);
                    await load();
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
