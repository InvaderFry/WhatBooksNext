import { useCallback, useEffect, useState } from 'react';
import { api, PROGRESS_LABELS, type CardGap, type SeriesView } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/**
 * Series order and gaps (PLAN.md §12.5, §13.4): on a pick card, before the owner starts, and as
 * a section of the item page. Gaps are shown as text with an icon, never colour alone.
 */

const STATUS_TEXT: Record<SeriesView['status'], string> = {
  finished: 'Story finished',
  ongoing: 'Story ongoing',
  unknown: 'Not known whether the story is finished',
};

const SOURCE_TEXT: Record<string, string> = {
  hardcover: 'Hardcover',
  anilist: 'AniList',
  openlibrary: 'Open Library',
  demo: 'the demo source (invented)',
  owner: 'you',
  file: 'the files',
};

function numbers(g: Pick<CardGap, 'from' | 'to' | 'unit'>): string {
  return g.from === g.to ? `${g.unit} ${g.from}` : `${g.unit}s ${g.from}–${g.to}`;
}

/** "Mark volume 3 read elsewhere": fills the gap with a record of reading, never ownership. */
async function markRead(seriesId: string, g: CardGap) {
  await api.post(`/api/series/${seriesId}/read-elsewhere`, {
    unit: g.unit,
    from: g.from,
    to: g.to,
  });
}

/** The gap warning on a pick card (§13.4): continue anyway, mark read elsewhere, or fix. */
export function GapNotice({
  gaps,
  seriesId,
  itemId,
  onMarked,
}: {
  gaps: CardGap[];
  seriesId: string;
  itemId: string;
  onMarked: (message: string) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (gaps.length === 0) return null;
  if (dismissed)
    return (
      <p className="muted small">
        <span aria-hidden="true">⚠ </span>Series gap noted.{' '}
        <button type="button" className="link-button" onClick={() => setDismissed(false)}>
          Show
        </button>
      </p>
    );
  return (
    <div className="gap-notice" role="note" aria-label="Series gap">
      <ul>
        {gaps.map((g) => (
          <li key={`${g.unit}-${g.from}`}>
            <span aria-hidden="true">⚠ </span>
            {g.text}
          </li>
        ))}
      </ul>
      <div className="row-actions wrap">
        <button type="button" className="small secondary" onClick={() => setDismissed(true)}>
          Continue anyway
        </button>
        {gaps
          .filter((g) => g.state === 'not_owned')
          .map((g) => (
            <button
              key={`m-${g.unit}-${g.from}`}
              type="button"
              className="small secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await markRead(seriesId, g);
                  onMarked(`${capital(numbers(g))} marked as read elsewhere.`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              I read {numbers(g)} elsewhere
            </button>
          ))}
        <a
          className="small"
          href={`${hrefFor({ view: 'item', id: itemId })}#series-h`}
          onClick={onLinkClick({ view: 'item', id: itemId })}
        >
          Fix the series
        </a>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The item page's series section: order, holdings, gaps, status, and the owner's fixes. */
export function SeriesSection({
  itemId,
  seriesId,
  position,
  seriesOverride,
  positionOverride,
  onSave,
}: {
  itemId: string;
  seriesId: string | null;
  position: number | null;
  seriesOverride: string | null;
  positionOverride: number | null;
  onSave: (
    patch: { seriesOverride?: string | null; seriesPositionOverride?: number | null },
    message: string,
  ) => Promise<void>;
}) {
  const [s, setS] = useState<SeriesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!seriesId) return setS(null);
    try {
      setS(await api.get<SeriesView>(`/api/series/${seriesId}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [seriesId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section aria-labelledby="series-h" className="card series-card">
      <h2 id="series-h">Series</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {!seriesId && !editing && (
        <p className="muted">
          {seriesOverride === ''
            ? 'You said this isn’t part of a series.'
            : 'Not part of a series, as far as the app knows.'}
        </p>
      )}
      {s && (
        <>
          <p>
            <strong>{s.name}</strong>
            {position !== null && (
              <span>
                {' '}
                · this is {s.entries.find((e) => e.id === itemId)?.unit ?? 'volume'}{' '}
                {s.entries.find((e) => e.id === itemId)?.label}
              </span>
            )}
          </p>
          <p className="muted small">
            {STATUS_TEXT[s.status]}
            {s.statusSource && ` (from ${SOURCE_TEXT[s.statusSource] ?? s.statusSource})`}
            {s.total !== null && ` · ${s.total} volumes in all`}
            {s.orderSource && ` · order from ${SOURCE_TEXT[s.orderSource] ?? s.orderSource}`}
          </p>
          <div className="field inline">
            <label htmlFor="series-status">Is the story finished?</label>
            <select
              id="series-status"
              value={s.ownerStatus ?? ''}
              onChange={(e) =>
                void act(() =>
                  api.put(`/api/series/${s.id}`, {
                    status: (e.target.value || null) as 'finished' | 'ongoing' | null,
                  }),
                )
              }
            >
              <option value="">Go by the sources</option>
              <option value="finished">Yes, it’s finished</option>
              <option value="ongoing">No, it’s ongoing</option>
            </select>
          </div>

          <ol className="series-list">
            {s.entries.map((e) => (
              <li key={e.id} className={e.id === itemId ? 'current' : undefined}>
                <span className="series-num">
                  {e.label === null ? '–' : `${e.unit === 'issue' ? '#' : 'Vol. '}${e.label}`}
                </span>
                <span className="series-title">
                  {e.id === itemId ? (
                    <strong>{e.title} (this one)</strong>
                  ) : (
                    <a
                      href={hrefFor({ view: 'item', id: e.id })}
                      onClick={onLinkClick({ view: 'item', id: e.id })}
                    >
                      {e.title}
                    </a>
                  )}
                </span>
                <span className="series-state">
                  {e.holding === 'read_elsewhere' ? (
                    <>
                      <span aria-hidden="true">✓ </span>Read elsewhere{' '}
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void act(() => api.delete(`/api/items/${e.id}`))}
                      >
                        Undo
                      </button>
                    </>
                  ) : (
                    <>
                      {e.holding === 'unavailable' && (
                        <>
                          <span aria-hidden="true">✕ </span>File missing ·{' '}
                        </>
                      )}
                      {e.holding === 'owned' && e.availabilityLabel && `${e.availabilityLabel} · `}
                      {PROGRESS_LABELS[e.progress]}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>

          {s.gaps.length > 0 && (
            <ul className="gap-list" aria-label="Gaps">
              {s.gaps.map((g) => (
                <li key={`${g.unit}-${g.from}`}>
                  <span aria-hidden="true">⚠ </span>
                  {g.text}{' '}
                  {g.state === 'not_owned' && (
                    <button
                      type="button"
                      className="small secondary"
                      onClick={() => void act(() => markRead(s.id, g))}
                    >
                      I read {numbers(g)} elsewhere
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {s.missingAfter && (
            <p className="muted small">
              Not owned yet: {numbers({ ...s.missingAfter, unit: 'volume' })} of {s.total}.
            </p>
          )}
          {s.unnumbered > 0 && (
            <p className="muted small">
              {s.unnumbered} {s.unnumbered === 1 ? 'entry has' : 'entries have'} no number, so
              {s.unnumbered === 1 ? ' its' : ' their'} place in the order is unknown. Give{' '}
              {s.unnumbered === 1 ? 'it' : 'them'} a number to fill a gap.
            </p>
          )}
        </>
      )}

      {editing ? (
        <SeriesEditor
          name={seriesOverride ?? s?.name ?? ''}
          position={positionOverride ?? position}
          onCancel={() => setEditing(false)}
          onSave={async (patch, message) => {
            await onSave(patch, message);
            setEditing(false);
          }}
        />
      ) : (
        <div className="row-actions wrap">
          <button type="button" className="small secondary" onClick={() => setEditing(true)}>
            {seriesId ? 'Correct series or number' : 'Put it in a series'}
          </button>
          {(seriesOverride !== null || positionOverride !== null) && (
            <button
              type="button"
              className="link-button"
              onClick={() =>
                void onSave(
                  { seriesOverride: null, seriesPositionOverride: null },
                  'The app decides the series again',
                )
              }
            >
              Let the app decide
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SeriesEditor({
  name,
  position,
  onSave,
  onCancel,
}: {
  name: string;
  position: number | null;
  onSave: (
    patch: { seriesOverride?: string | null; seriesPositionOverride?: number | null },
    message: string,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [n, setN] = useState(name);
  const [p, setP] = useState(position === null ? '' : String(position));
  const num = p.trim() === '' ? null : Number(p);
  const bad = num !== null && !(Number.isFinite(num) && num >= 0);
  return (
    <form
      className="series-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        // Only what changed becomes a correction, so an unchanged name keeps following the app.
        const patch: { seriesOverride?: string; seriesPositionOverride?: number | null } = {};
        if (n.trim() !== name.trim()) patch.seriesOverride = n.trim();
        if (num !== position) patch.seriesPositionOverride = num;
        if (Object.keys(patch).length === 0) return onCancel();
        void onSave(patch, n.trim() ? 'Series saved' : 'Taken out of its series');
      }}
    >
      <div className="field">
        <label htmlFor="series-name">Series name (leave empty: not part of a series)</label>
        <input id="series-name" value={n} onChange={(e) => setN(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="series-pos">Number in the series</label>
        <input
          id="series-pos"
          inputMode="decimal"
          value={p}
          aria-invalid={bad}
          aria-describedby="series-pos-help"
          onChange={(e) => setP(e.target.value)}
        />
        <p id="series-pos-help" className="muted small">
          {bad
            ? 'Use a number such as 3 or 1.5.'
            : 'Leave empty if it has no number (a side story).'}
        </p>
      </div>
      <div className="row-actions">
        <button type="submit" className="small">
          Save
        </button>
        <button type="button" className="small secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
