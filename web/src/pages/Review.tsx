import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatBytes,
  FORMAT_LABELS,
  KIND_LABELS,
  type Candidate,
  type Kind,
  type MatchReport,
  type ReviewList,
  type ReviewRow,
} from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';
import { OperationsList } from './MergeSplit.tsx';

/**
 * Needs review (PLAN.md §11.4): tiered, worked top-down. Tier 1 could damage history; tier 2 is
 * conflicting identity; tier 3 is unidentified books that matter now; tier 4 (collapsed) is
 * everything else. Every row can be deferred or dismissed. Review never blocks anything else.
 */

const TIER_TITLES: Record<number, string> = {
  1: 'Could affect your reading history',
  2: 'Which book is it?',
  3: 'Books that matter now',
  4: 'Everything else',
};

const KIND_TITLES: Record<ReviewRow['kind'], string> = {
  move: 'Did this file move?',
  group_conflict: 'These files may not be the same book',
  copy_conflict: 'The same file is on two books',
  cross_folder: 'The same book twice?',
  pdf_type: 'What kind of PDF is this?',
  tie: 'Two possible matches',
  wrong_match: 'You said this was the wrong book',
  unidentified: 'Not found online',
  provisional: 'Unconfirmed match',
  check_match: 'Check this match',
  store_not_seen: 'Still yours in the store?',
};

export function Review({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<ReviewList | null>(null);
  const [report, setReport] = useState<MatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/api/review'));
      setReport(await api.get('/api/match-report'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setError(null);
    try {
      await fn();
      setDone(message);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = (row: ReviewRow, action: string, fileId?: string, message = 'Done') =>
    run(() => api.post(`/api/review/${row.id}`, { action, fileId }), message);
  const setPdfType = (row: ReviewRow, type: string) =>
    run(
      () => api.patch(`/api/files/${row.files[0]!.id}`, { pdfTypeOverride: type }),
      'PDF type saved',
    );
  const match = (row: ReviewRow, body: object, message: string) =>
    run(() => api.post(`/api/items/${row.items[0]!.id}/match`, body), message);
  const later = (row: ReviewRow, state: 'deferred' | 'dismissed') =>
    run(
      () => api.post('/api/review-state', { key: row.id, state }),
      state === 'deferred' ? 'Hidden for 30 days' : 'Dismissed',
    );

  const tier = (n: number) => data?.rows.filter((r) => r.tier === n) ?? [];
  const handlers = { act, setPdfType, match, later, run };

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
      {report && <MatchSummary report={report} />}
      <div className="live" aria-live="polite">
        {done && <span className="saved">✓ {done}</span>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data && data.rows.length === 0 && (
        <Notice kind="success">Nothing to review. Everything the scan found was clear.</Notice>
      )}
      {data && data.rows.length > 0 && (
        <p className="tier-counts">
          {[1, 2, 3, 4]
            .filter((n) => tier(n).length > 0)
            .map((n) => `${TIER_TITLES[n]} (${tier(n).length})`)
            .join(' · ')}
          {data.hidden > 0 && ` · ${data.hidden} deferred or dismissed`}
        </p>
      )}
      {data &&
        (['cross_folder', 'move'] as const).some(
          (k) => data.rows.filter((r) => r.kind === k).length >= 2,
        ) && (
          <section className="section bulk-top" aria-labelledby="bulk-top-h">
            <h2 id="bulk-top-h" className="visually-hidden">
              Answer many at once
            </h2>
            {/* "Confirm all like this" (§11.4), up front: the rows it answers can sit in the
              collapsed "Everything else" section, where the owner didn't find it. */}
            <BulkBar rows={data.rows} run={run} />
          </section>
        )}
      {[1, 2, 3].map(
        (n) =>
          tier(n).length > 0 && (
            <section key={n} aria-labelledby={`tier${n}-h`} className="section">
              <h2 id={`tier${n}-h`}>{TIER_TITLES[n]}</h2>
              <ul className="review-list">
                {tier(n).map((r) => (
                  <ReviewCard key={r.id} row={r} {...handlers} />
                ))}
              </ul>
            </section>
          ),
      )}
      {data && (tier(4).length > 0 || data.notListed.unidentified > 0) && (
        <details className="section tier4">
          <summary>
            <h2>
              {TIER_TITLES[4]} ({tier(4).length})
            </h2>
          </summary>
          {(data.notListed.unidentified > 0 || data.notListed.provisional > 0) && (
            <p className="muted">
              {data.notListed.unidentified > 0 &&
                `${data.notListed.unidentified.toLocaleString()} books weren’t found online and aren’t urgent; they’re recommended with neutral scores. `}
              {data.notListed.provisional > 0 &&
                `${data.notListed.provisional.toLocaleString()} more unconfirmed matches aren’t listed here.`}
            </p>
          )}
          <ul className="review-list">
            {tier(4).map((r) => (
              <ReviewCard key={r.id} row={r} {...handlers} />
            ))}
          </ul>
        </details>
      )}
      <OperationsList />
    </div>
  );
}

/** Match quality (§11.5) and data coverage by kind (§12.1). */
function MatchSummary({ report }: { report: MatchReport }) {
  const b = report.byBand;
  const looked = b.accepted + b.provisional + b.tie + b.unidentified;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');
  return (
    <details className="card match-summary">
      <summary>
        <strong>Matches:</strong> {b.accepted} matched · {b.provisional} unconfirmed · {b.tie} tied
        · {b.unidentified} not found
        {b.notLookedUp > 0 && ` · ${b.notLookedUp} not looked up yet`}
        {b.noSourceYet > 0 &&
          ` · ${b.noSourceYet} single comic issues (set up Metron in Settings to look them up)`}
      </summary>
      <p className="small">
        Your answers so far: {report.labelled.confirmed} matches confirmed,{' '}
        {report.labelled.rejected} rejected
        {report.labelled.precision !== null &&
          ` (${Math.round(report.labelled.precision * 100)}% right)`}
        . Wrong matches that had been accepted automatically:{' '}
        <strong>{report.labelled.wrongHighConfidence}</strong>.
        {looked > 0 &&
          ` Identified: ${pct(b.accepted + b.provisional, looked)} of books looked up.`}
      </p>
      <table className="table small">
        <caption className="visually-hidden">Data coverage by kind</caption>
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Books</th>
            <th scope="col">Rated</th>
            <th scope="col">Length known</th>
            <th scope="col">Series known</th>
          </tr>
        </thead>
        <tbody>
          {report.coverage.map((c) => (
            <tr key={c.kind}>
              <th scope="row">{KIND_LABELS[c.kind as Kind] ?? 'Kind unknown'}</th>
              <td>{c.items}</td>
              <td>{pct(c.rated, c.items)}</td>
              <td>{pct(c.lengthKnown, c.items)}</td>
              <td>{pct(c.seriesKnown, c.items)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Western comics have almost no community ratings anywhere; their picks rest on your own
        signals. Single comic issues are looked up only on Metron and ComicVine, which need a free
        key (Settings → Online lookups).
      </p>
    </details>
  );
}

/** "Confirm all like this" (§11.4) for rows of one kind, with a preview first. */
function BulkBar({
  rows,
  run,
}: {
  rows: ReviewRow[];
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const kinds = (['cross_folder', 'move'] as const).filter(
    (k) => rows.filter((r) => r.kind === k).length >= 2,
  );
  const [preview, setPreview] = useState<{
    kind: string;
    action: string;
    total: number;
    done: number;
    skipped: { reason: string }[];
    sample: string[];
  } | null>(null);
  if (kinds.length === 0) return null;
  const label = (k: string, a: string) =>
    k === 'cross_folder'
      ? a === 'accept'
        ? 'Group all as the same book'
        : 'Keep all apart'
      : a === 'accept'
        ? 'Yes to all: they moved'
        : 'No to all';
  return (
    <div className="bulk-bar">
      {kinds.map((k) => (
        <div key={k} className="row-actions wrap">
          <span className="small">
            {rows.filter((r) => r.kind === k).length} rows like “{KIND_TITLES[k]}”:
          </span>
          {(['accept', 'decline'] as const).map((a) => (
            <button
              key={a}
              type="button"
              className="secondary small"
              onClick={async () => {
                const p = await api.post<NonNullable<typeof preview>>('/api/review/bulk', {
                  kind: k,
                  action: a,
                  preview: true,
                });
                setPreview({ ...p, kind: k, action: a });
              }}
            >
              {label(k, a)}…
            </button>
          ))}
        </div>
      ))}
      {preview && (
        <div className="confirm" role="alertdialog" aria-labelledby="bulk-h">
          <p id="bulk-h">
            <strong>
              {label(preview.kind, preview.action)}: {preview.done} of {preview.total}
            </strong>
            {preview.skipped.length > 0 &&
              ` (${preview.skipped.length} skipped: ${[...new Set(preview.skipped.map((s) => s.reason))].join(', ')})`}
            . For example: {preview.sample.slice(0, 5).join('; ')}
            {preview.sample.length > 5 ? '…' : ''}
          </p>
          <button
            type="button"
            className="small"
            onClick={async () => {
              const p = preview;
              setPreview(null);
              await run(
                () =>
                  api.post('/api/review/bulk', { kind: p.kind, action: p.action, preview: false }),
                `${p.done} done`,
              );
            }}
          >
            Do all {preview.done}
          </button>
          <button type="button" className="secondary small" onClick={() => setPreview(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  row,
  act,
  setPdfType,
  match,
  later,
  run,
}: {
  row: ReviewRow;
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
  act: (row: ReviewRow, action: string, fileId?: string, message?: string) => Promise<void>;
  setPdfType: (row: ReviewRow, type: string) => Promise<void>;
  match: (row: ReviewRow, body: object, message: string) => Promise<void>;
  later: (row: ReviewRow, state: 'deferred' | 'dismissed') => Promise<void>;
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
        {row.kind === 'cross_folder' && row.items.filter((i) => i.hasHistory).length > 1 && (
          <MergeLink row={row} />
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
            <p className="muted small">Both books have your history.</p>
            <MergeLink row={row} />
            <button
              type="button"
              className="secondary small"
              onClick={() => void act(row, 'decline', undefined, 'Kept apart')}
            >
              Keep apart
            </button>
          </>
        )}
        {row.candidates && <IdentityChoices row={row} match={match} />}
        {row.kind === 'store_not_seen' && (
          <>
            <button
              type="button"
              className="small"
              onClick={() =>
                void run(
                  () =>
                    api.post(`/api/store-purchases/${row.id.replace('notseen:', '')}/not-seen`, {
                      action: 'keep',
                    }),
                  'Kept',
                )
              }
            >
              Keep
            </button>
            <button
              type="button"
              className="small secondary"
              onClick={() =>
                void run(
                  () =>
                    api.post(`/api/store-purchases/${row.id.replace('notseen:', '')}/not-seen`, {
                      action: 'remove',
                    }),
                  'Store copy removed',
                )
              }
            >
              Remove the store copy
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
      <div className="row-actions wrap later">
        <button
          type="button"
          className="link-button small"
          onClick={() => void later(row, 'deferred')}
        >
          Decide later (hide for 30 days)
        </button>
        <button
          type="button"
          className="link-button small"
          onClick={() => void later(row, 'dismissed')}
        >
          Dismiss — it’s fine as it is
        </button>
      </div>
    </li>
  );
}

/** Confirm, Not this one, Search and pick, Leave unidentified (§11.4). */
function IdentityChoices({
  row,
  match,
}: {
  row: ReviewRow;
  match: (row: ReviewRow, body: object, message: string) => Promise<void>;
}) {
  const item = row.items[0]!;
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const list = results ?? row.candidates ?? [];
  return (
    <div className="identity">
      {list.length > 0 && (
        <ul className="plain candidates">
          {list.map((c) => (
            <CandidateRow
              key={`${c.source}:${c.sourceId}`}
              c={c}
              onConfirm={() =>
                void match(
                  row,
                  { action: 'confirm', source: c.source, sourceId: c.sourceId },
                  `Matched to ${c.title}`,
                )
              }
              onReject={
                results
                  ? undefined
                  : () =>
                      void match(
                        row,
                        { action: 'reject', source: c.source, sourceId: c.sourceId },
                        `${c.title} won’t be suggested again`,
                      )
              }
            />
          ))}
        </ul>
      )}
      {results && results.length === 0 && <p className="muted small">Nothing found.</p>}
      {searchError && <p className="small warn">{searchError}</p>}
      {query === null ? (
        <div className="row-actions wrap">
          <button type="button" className="secondary small" onClick={() => setQuery(item.title)}>
            Search…
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => void match(row, { action: 'none' }, 'Left unidentified')}
          >
            Leave unidentified
          </button>
        </div>
      ) : (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSearching(true);
            setSearchError(null);
            try {
              const r = await api.post<{ candidates: Candidate[]; errors: string[] }>(
                `/api/items/${item.id}/search`,
                { query },
              );
              setResults(r.candidates);
              if (r.errors.length) setSearchError(r.errors.join(' · '));
            } catch (err) {
              setSearchError((err as Error).message);
            } finally {
              setSearching(false);
            }
          }}
        >
          <label className="visually-hidden" htmlFor={`q-${row.id}`}>
            Search for {item.title}
          </label>
          <input id={`q-${row.id}`} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="small" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
      )}
    </div>
  );
}

export function CandidateRow({
  c,
  onConfirm,
  onReject,
}: {
  c: Candidate;
  onConfirm: () => void;
  onReject?: () => void;
}) {
  return (
    <li className="candidate">
      <div>
        <strong>{c.title}</strong>
        {c.subtitle && <span>: {c.subtitle}</span>}
        <span className="muted small">
          {c.authors.length > 0 && ` · ${c.authors.join(', ')}`}
          {c.year && ` · ${c.year}`} · {c.sourceLabel}
          {c.rating && ` · rated ${c.rating}`} · match {Math.round(c.score * 100)}
        </span>
        {c.notes.length > 0 && <div className="muted small">{c.notes.join(' ')}</div>}
        {c.url && (
          <a className="small" href={c.url} target="_blank" rel="noreferrer noopener">
            View on {c.sourceLabel}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="small"
          onClick={onConfirm}
          aria-label={`This is it: ${c.title}`}
        >
          This is it
        </button>
        {onReject && (
          <button
            type="button"
            className="secondary small"
            onClick={onReject}
            aria-label={`Not this one: ${c.title}`}
          >
            Not this one
          </button>
        )}
      </div>
    </li>
  );
}

/** Both entries have history: merge on the book's page, which previews what conflicts. */
function MergeLink({ row }: { row: ReviewRow }) {
  const [a, b] = row.items;
  if (!a || !b) return null;
  return (
    <a
      className="small"
      href={hrefFor({ view: 'item', id: a.id, merge: b.id })}
      onClick={onLinkClick({ view: 'item', id: a.id, merge: b.id })}
    >
      Merge, choosing what to keep…
    </a>
  );
}
