import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, type FileDetail, type ItemSummary } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, navigate, onLinkClick } from '../url.ts';

/**
 * Merge, split and undo (PLAN.md §11.4). A merge previews only what conflicts and asks which to
 * keep; a split says which files and whether the reading history go to the new book. The last
 * 20 can be undone while nothing has changed since; otherwise the opposite action is offered.
 */

interface Conflict {
  field: string;
  label: string;
  keep: string;
  other: string;
  allowBoth: boolean;
}

interface MergePreview {
  keep: { id: string; title: string; files: number };
  other: { id: string; title: string; files: number };
  conflicts: Conflict[];
  carried: string[];
}

interface SplitPreview {
  item: { id: string; title: string };
  stay: { id: string; name: string }[];
  move: { id: string; name: string }[];
  ownerData: string[];
}

export interface OperationView {
  id: string;
  kind: 'merge' | 'split';
  summary: string;
  createdAt: string;
  undoneAt: string | null;
  canUndo: boolean;
  blockedBecause: string | null;
  instead:
    | { kind: 'split'; itemId: string; fileIds: string[] }
    | { kind: 'merge'; keepId: string; otherId: string }
    | null;
}

function UndoButton({ operationId, onDone }: { operationId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="small secondary"
        onClick={async () => {
          try {
            await api.post(`/api/operations/${operationId}/undo`);
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Undo
      </button>
      {error && <Notice kind="error">{error}</Notice>}
    </>
  );
}

/** "Same book as another entry?": find it, preview the conflicts, choose, merge. */
export function MergeCard({ itemId, initialOther }: { itemId: string; initialOther?: string }) {
  const [open, setOpen] = useState(Boolean(initialOther));
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ItemSummary[]>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ operationId: string; summary: string } | null>(null);

  const load = useCallback(
    async (otherId: string) => {
      setError(null);
      try {
        setPreview(await api.post<MergePreview>('/api/merge/preview', { keepId: itemId, otherId }));
        setChoices({});
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [itemId],
  );
  useEffect(() => {
    if (initialOther) void load(initialOther);
  }, [initialOther, load]);

  if (done)
    return (
      <section className="card series-card" aria-labelledby="merge-h">
        <h2 id="merge-h">Merged</h2>
        <p>
          <span aria-hidden="true">✓ </span>
          {done.summary}.{' '}
          <UndoButton
            operationId={done.operationId}
            onDone={() => navigate({ view: 'item', id: itemId })}
          />
        </p>
      </section>
    );

  return (
    <section className="card series-card" aria-labelledby="merge-h">
      <h2 id="merge-h">Same book as another entry?</h2>
      {!open ? (
        <button type="button" className="small secondary" onClick={() => setOpen(true)}>
          Merge with another entry…
        </button>
      ) : (
        <>
          {!preview && (
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await api.get<{ items: ItemSummary[] }>(
                  `/api/items?q=${encodeURIComponent(q)}&limit=10&hidden=1`,
                );
                setFound(r.items.filter((i) => i.id !== itemId));
              }}
            >
              <label htmlFor="merge-q">Find the other entry</label>
              <input id="merge-q" value={q} onChange={(e) => setQ(e.target.value)} />
              <button type="submit" disabled={!q.trim()}>
                Search
              </button>
            </form>
          )}
          {!preview && found.length > 0 && (
            <ul className="plain-list">
              {found.map((i) => (
                <li key={i.id}>
                  <button type="button" className="link-button" onClick={() => void load(i.id)}>
                    {i.title}
                  </button>{' '}
                  <span className="muted small">
                    {i.formats.join(' · ')} · {i.fileCount} file{i.fileCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {preview && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  const r = await api.post<{ operationId: string }>('/api/merge', {
                    keepId: itemId,
                    otherId: preview.other.id,
                    choices,
                  });
                  setDone({
                    operationId: r.operationId,
                    summary: `“${preview.other.title}” merged into this book`,
                  });
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <p>
                <strong>“{preview.other.title}”</strong> ({preview.other.files} file
                {preview.other.files === 1 ? '' : 's'}) joins this book. Its files come along, and
                its old link still leads here.
              </p>
              {preview.conflicts.length === 0 ? (
                <p className="muted">Nothing conflicts.</p>
              ) : (
                preview.conflicts.map((c) => (
                  <fieldset key={c.field} className="radio-row">
                    <legend>{c.label}: they differ. Keep which?</legend>
                    <label>
                      <input
                        type="radio"
                        name={`m-${c.field}`}
                        checked={choices[c.field] === 'keep'}
                        onChange={() => setChoices({ ...choices, [c.field]: 'keep' })}
                      />
                      This book’s: {c.keep}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`m-${c.field}`}
                        checked={choices[c.field] === 'other'}
                        onChange={() => setChoices({ ...choices, [c.field]: 'other' })}
                      />
                      The other’s: {c.other}
                    </label>
                    {c.allowBoth && (
                      <label>
                        <input
                          type="radio"
                          name={`m-${c.field}`}
                          checked={choices[c.field] === 'both'}
                          onChange={() => setChoices({ ...choices, [c.field]: 'both' })}
                        />
                        Keep both
                      </label>
                    )}
                  </fieldset>
                ))
              )}
              {preview.carried.length > 0 && (
                <p className="muted small">Also comes along: {preview.carried.join(' · ')}.</p>
              )}
              <p className="muted small">
                One reading stays one reading: the merged book has a single progress.
              </p>
              <div className="row-actions">
                <button type="submit" disabled={preview.conflicts.some((c) => !choices[c.field])}>
                  Merge
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setPreview(null);
                    setOpen(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}

/** "Split off…": choose files, and whether the reading history stays or goes with them. */
export function SplitCard({
  itemId,
  files,
  initialFiles,
}: {
  itemId: string;
  files: FileDetail[];
  initialFiles?: string[];
}) {
  const [chosen, setChosen] = useState<string[]>(initialFiles ?? []);
  const [ownerData, setOwnerData] = useState<'stay' | 'move'>('stay');
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ operationId: string; newItemId: string } | null>(null);

  useEffect(() => {
    if (!initialFiles?.length) return;
    void api
      .post<SplitPreview>('/api/split/preview', { itemId, fileIds: initialFiles })
      .then(setPreview, (e: Error) => setError(e.message));
  }, [itemId, initialFiles]);

  if (files.length < 2) return null;
  if (done)
    return (
      <section className="card series-card" aria-labelledby="split-h">
        <h2 id="split-h">Split</h2>
        <p>
          <span aria-hidden="true">✓ </span>
          Split off into{' '}
          <a
            href={hrefFor({ view: 'item', id: done.newItemId })}
            onClick={onLinkClick({ view: 'item', id: done.newItemId })}
          >
            a book of its own
          </a>
          .{' '}
          <UndoButton
            operationId={done.operationId}
            onDone={() => navigate({ view: 'item', id: itemId })}
          />
        </p>
      </section>
    );
  return (
    <section className="card series-card" aria-labelledby="split-h">
      <h2 id="split-h">Not all the same book?</h2>
      <fieldset className="checks">
        <legend>Split these files off into a book of their own</legend>
        {files.map((f) => (
          <label key={f.id} className="check">
            <input
              type="checkbox"
              checked={chosen.includes(f.id)}
              onChange={(e) => {
                setPreview(null);
                setChosen(e.target.checked ? [...chosen, f.id] : chosen.filter((x) => x !== f.id));
              }}
            />
            {f.name}{' '}
            <span className="muted small">
              (
              {[
                f.folderPath.split(/[\\/]/).filter(Boolean).at(-1),
                ...f.relPath.split('/').slice(0, -1),
              ]
                .filter(Boolean)
                .join(' › ')}
              )
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="radio-row">
        <legend>Your reading history (progress, rating, notes)</legend>
        <label>
          <input
            type="radio"
            name="split-owner"
            checked={ownerData === 'stay'}
            onChange={() => setOwnerData('stay')}
          />
          Stays with this book
        </label>
        <label>
          <input
            type="radio"
            name="split-owner"
            checked={ownerData === 'move'}
            onChange={() => setOwnerData('move')}
          />
          Goes with the split-off files
        </label>
      </fieldset>
      {!preview ? (
        <button
          type="button"
          className="small secondary"
          disabled={chosen.length === 0}
          onClick={async () => {
            setError(null);
            try {
              setPreview(
                await api.post<SplitPreview>('/api/split/preview', { itemId, fileIds: chosen }),
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Preview the split…
        </button>
      ) : (
        <div>
          <p>
            <strong>Stays here:</strong> {preview.stay.map((f) => f.name).join(', ')}
            <br />
            <strong>New book:</strong> {preview.move.map((f) => f.name).join(', ')}
          </p>
          <p className="small">
            {preview.ownerData.length === 0
              ? 'You haven’t recorded anything on this book yet.'
              : `${ownerData === 'stay' ? 'Stays here' : 'Goes to the new book'}: ${preview.ownerData.join(' · ')}.`}{' '}
            <span className="muted">It’s never copied, so a reading is never counted twice.</span>
          </p>
          <div className="row-actions">
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  setDone(
                    await api.post('/api/split', {
                      itemId,
                      fileIds: preview.move.map((f) => f.id),
                      ownerData,
                    }),
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Split
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}

/** Needs review → "Recent merges and splits": undo, or the opposite action with a preview. */
export function OperationsList() {
  const [ops, setOps] = useState<OperationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOps(await api.get<OperationView[]>('/api/operations'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!ops || ops.length === 0) return null;
  return (
    <section className="section" aria-labelledby="ops-h">
      <h2 id="ops-h">Recent merges and splits</h2>
      <p className="muted small">
        The last 20. Undo puts things back exactly as they were, as long as nothing has changed
        since.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="folder-list">
        {ops.map((o) => (
          <li key={o.id} className="card source-row">
            <strong>{o.summary}</strong>{' '}
            <span className="muted small">{formatDate(o.createdAt)}</span>
            <div className="row-actions wrap">
              {o.undoneAt ? (
                <span className="muted small">Undone {formatDate(o.undoneAt)}.</span>
              ) : o.canUndo ? (
                <UndoButton operationId={o.id} onDone={() => void load()} />
              ) : (
                <>
                  <span className="small warn">{o.blockedBecause}</span>
                  {o.instead?.kind === 'split' && (
                    <a
                      className="small"
                      href={hrefFor({
                        view: 'item',
                        id: o.instead.itemId,
                        split: o.instead.fileIds.join(','),
                      })}
                      onClick={onLinkClick({
                        view: 'item',
                        id: o.instead.itemId,
                        split: o.instead.fileIds.join(','),
                      })}
                    >
                      Split them apart instead (with a preview)
                    </a>
                  )}
                  {o.instead?.kind === 'merge' && (
                    <a
                      className="small"
                      href={hrefFor({
                        view: 'item',
                        id: o.instead.keepId,
                        merge: o.instead.otherId,
                      })}
                      onClick={onLinkClick({
                        view: 'item',
                        id: o.instead.keepId,
                        merge: o.instead.otherId,
                      })}
                    >
                      Merge them again instead (with a preview)
                    </a>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
