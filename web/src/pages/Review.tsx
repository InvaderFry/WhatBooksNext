import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, FORMAT_LABELS, type ReviewRow } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/**
 * Needs review (PLAN.md §11.4) as of M2: what the deep pass found. Tier 1 could damage history
 * and comes first; tier 4 is collapsed. Review never blocks anything else in the app.
 */

const TIER_TITLES: Record<number, string> = {
  1: 'Could affect your reading history',
  4: 'Everything else',
};

const KIND_TITLES: Record<ReviewRow['kind'], string> = {
  move: 'Did this file move?',
  group_conflict: 'These files may not be the same book',
  copy_conflict: 'The same file is on two books',
  cross_folder: 'The same book in two folders?',
  pdf_type: 'What kind of PDF is this?',
};

export function Review({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ tiers: Record<number, number>; rows: ReviewRow[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/api/review'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: ReviewRow, action: string, fileId?: string, message = 'Done') => {
    setError(null);
    try {
      await api.post(`/api/review/${row.id}`, { action, fileId });
      setDone(message);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setPdfType = async (row: ReviewRow, type: string) => {
    setError(null);
    try {
      await api.patch(`/api/files/${row.files[0]!.id}`, { pdfTypeOverride: type });
      setDone('PDF type saved');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tier = (n: number) => data?.rows.filter((r) => r.tier === n) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Needs review</h1>
        <p className="muted">
          Questions only you can answer. Nothing here blocks the rest of the app, and nothing moves
          reading history without your say-so.
        </p>
        <p>
          <a href={hrefFor({ view: 'health' })} onClick={onLinkClick({ view: 'health' })}>
            Library health
          </a>{' '}
          lists files that couldn’t be read.
        </p>
      </div>
      <div className="live" aria-live="polite">
        {done && <span className="saved">✓ {done}</span>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data && data.rows.length === 0 && (
        <Notice kind="success">Nothing to review. Everything the scan found was clear.</Notice>
      )}
      {data && data.rows.length > 0 && (
        <>
          {tier(1).length > 0 && tier(4).length > 0 && (
            <p className="tier-counts">
              {[1, 4]
                .filter((n) => tier(n).length > 0)
                .map((n) => `${TIER_TITLES[n]}: ${tier(n).length}`)
                .join(' · ')}
            </p>
          )}
          {tier(1).length > 0 && (
            <section aria-labelledby="tier1-h" className="section">
              <h2 id="tier1-h">{TIER_TITLES[1]}</h2>
              <ul className="review-list">
                {tier(1).map((r) => (
                  <ReviewCard key={r.id} row={r} act={act} setPdfType={setPdfType} />
                ))}
              </ul>
            </section>
          )}
          {tier(4).length > 0 && (
            <details className="section tier4">
              <summary>
                <h2>
                  {TIER_TITLES[4]} ({tier(4).length})
                </h2>
              </summary>
              <ul className="review-list">
                {tier(4).map((r) => (
                  <ReviewCard key={r.id} row={r} act={act} setPdfType={setPdfType} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function ReviewCard({
  row,
  act,
  setPdfType,
}: {
  row: ReviewRow;
  act: (row: ReviewRow, action: string, fileId?: string, message?: string) => Promise<void>;
  setPdfType: (row: ReviewRow, type: string) => Promise<void>;
}) {
  const headingId = `rv-${row.id.replace(/[^a-zA-Z0-9-]/g, '')}`;
  return (
    <li className="card review-card" aria-labelledby={headingId}>
      <h3 id={headingId}>{KIND_TITLES[row.kind]}</h3>
      <p>{row.why}</p>
      <ul className="plain review-items">
        {row.items.map((i) => (
          <li key={i.id}>
            <a
              href={hrefFor({ view: 'item', id: i.id })}
              onClick={onLinkClick({ view: 'item', id: i.id })}
            >
              {i.title}
            </a>
            {i.hasHistory && <span className="tag">Has your history</span>}
          </li>
        ))}
      </ul>
      <ul className="plain review-files">
        {row.files.map((f) => (
          <li key={f.id} className="small">
            <strong>{f.name}</strong>
            <span className="muted">
              {' '}
              · {FORMAT_LABELS[f.format] ?? f.format} · {formatBytes(f.size)} · {f.folderPath}
              {f.relPath.includes('/') ? ` › ${f.relPath.split('/').slice(0, -1).join(' › ')}` : ''}
              {f.availability === 'missing' ? ' · missing' : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="row-actions wrap">
        {row.kind === 'move' && (
          <>
            <button
              type="button"
              className="small"
              onClick={() => void act(row, 'accept', undefined, 'History moved to the new file')}
            >
              Yes, it moved: keep its history
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() => void act(row, 'decline', undefined, 'Kept apart')}
            >
              No, they’re different files
            </button>
          </>
        )}
        {row.kind === 'cross_folder' && (
          <>
            <button
              type="button"
              className="small"
              onClick={() => void act(row, 'accept', undefined, 'Grouped as one book')}
            >
              Same book: group them
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() => void act(row, 'decline', undefined, 'Kept apart')}
            >
              Keep apart
            </button>
          </>
        )}
        {row.kind === 'group_conflict' && (
          <>
            {row.files.map((f) => (
              <button
                key={f.id}
                type="button"
                className="small"
                aria-label={`Split off ${f.name}`}
                onClick={() => void act(row, 'split', f.id, `${f.name} is now a book of its own`)}
              >
                Split off {f.name}
              </button>
            ))}
            <button
              type="button"
              className="secondary small"
              onClick={() => void act(row, 'decline', undefined, 'Kept together')}
            >
              Keep together
            </button>
          </>
        )}
        {row.kind === 'copy_conflict' && (
          <>
            <p className="muted small">
              Both books have your history. Merging them, with a preview of what conflicts, comes in
              a later version.
            </p>
            <button
              type="button"
              className="secondary small"
              onClick={() => void act(row, 'decline', undefined, 'Kept apart')}
            >
              Keep apart
            </button>
          </>
        )}
        {row.kind === 'pdf_type' && (
          <>
            <button type="button" className="small" onClick={() => void setPdfType(row, 'comic')}>
              It’s a comic or manga
            </button>
            <button type="button" className="small" onClick={() => void setPdfType(row, 'text')}>
              It’s a book
            </button>
            <button type="button" className="small" onClick={() => void setPdfType(row, 'scanned')}>
              It’s a scanned book
            </button>
          </>
        )}
      </div>
    </li>
  );
}
