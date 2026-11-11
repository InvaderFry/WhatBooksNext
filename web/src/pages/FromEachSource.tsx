import { formatDate, type FromEachSource, type SourceEntry } from '../api.ts';

/**
 * "From each source" (plan stage 3): every source asked about this book, what it said, and which
 * of its values the app uses and why. Unconfirmed matches are listed apart and never shown as
 * verified. Text from sources is shown as text only (§6.3, scenario 23).
 */

const FIELD_LABELS: Record<SourceEntry['used'][number]['field'], string> = {
  rating: 'Rating',
  title: 'Title',
  creators: 'Author',
  year: 'First published',
  pages: 'Pages',
  description: 'Description',
};

const SCOPE_TEXT: Record<'book' | 'volume' | 'series', string> = {
  book: 'this book',
  volume: 'this volume',
  series: 'the whole series',
};

function ratingText(r: NonNullable<SourceEntry['rating']>): string {
  const raw = `${r.value.toFixed(r.scale >= 100 ? 0 : 1)}/${r.scale}`;
  const count =
    r.count === null
      ? 'number of ratings unknown'
      : `from ${r.count.toLocaleString()} rating${r.count === 1 ? '' : 's'}`;
  return `${raw} ${count} — rates ${SCOPE_TEXT[r.scope]}`;
}

function Entry({
  e,
  busy,
  onConfirm,
  onReject,
}: {
  e: SourceEntry;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const r = e.record;
  const headingId = `source-${e.source}`;
  return (
    <li className={`card source-entry source-${e.status}`} aria-labelledby={headingId}>
      <h3 id={headingId} className="source-heading">
        {e.label} <span className="muted small">— {e.statusText}</span>
      </h3>
      {e.used.length > 0 && (
        <ul className="plain used-list" aria-label={`Used from ${e.label}`}>
          {e.used.map((u) => (
            <li key={u.field}>
              <span className="badge">Used</span> {FIELD_LABELS[u.field]}: {u.reason}
            </li>
          ))}
        </ul>
      )}
      {r && (
        <dl className="facts">
          <dt>Rating</dt>
          <dd>{e.rating ? ratingText(e.rating) : (e.ratingNote ?? 'None')}</dd>
          <dt>Title</dt>
          <dd>
            {r.title}
            {r.subtitle ? `: ${r.subtitle}` : ''}
          </dd>
          {r.authors.length > 0 && (
            <>
              <dt>By</dt>
              <dd>{r.authors.join(', ')}</dd>
            </>
          )}
          {r.year !== null && (
            <>
              <dt>Year</dt>
              <dd>{r.year}</dd>
            </>
          )}
          {r.pages !== null && (
            <>
              <dt>Pages</dt>
              <dd>{r.pages.toLocaleString()}</dd>
            </>
          )}
          {r.subjects.length > 0 && (
            <>
              <dt>Subjects</dt>
              <dd>{r.subjects.join(', ')}</dd>
            </>
          )}
        </dl>
      )}
      {r?.description && (
        <details>
          <summary>Description from {e.label}</summary>
          <p className="description">{r.description}</p>
        </details>
      )}
      <div className="row-actions wrap">
        {r?.url && (
          <a href={r.url} target="_blank" rel="noreferrer noopener">
            Open on {e.label}
          </a>
        )}
        {e.status === 'unconfirmed' && r && (
          <>
            <button type="button" className="small" disabled={busy} onClick={onConfirm}>
              This is the right book
            </button>
            <button type="button" className="secondary small" disabled={busy} onClick={onReject}>
              Not this book
            </button>
          </>
        )}
      </div>
      {e.lookedUpAt && <p className="muted small">Last looked up {formatDate(e.lookedUpAt)}</p>}
    </li>
  );
}

export function FromEachSourceSection({
  data,
  busy,
  onConfirm,
  onReject,
}: {
  data: FromEachSource;
  busy: boolean;
  onConfirm: (source: string, sourceId: string) => void;
  onReject: (source: string, sourceId: string) => void;
}) {
  const trusted = data.entries.filter((e) => e.status !== 'unconfirmed');
  const unconfirmed = data.entries.filter((e) => e.status === 'unconfirmed');
  const kind = data.notAsked.filter((n) => n.why === 'kind');
  const notSetUp = data.notAsked.filter((n) => n.why === 'not_set_up');
  const entry = (e: SourceEntry) => (
    <Entry
      key={e.source}
      e={e}
      busy={busy}
      onConfirm={() => e.record && onConfirm(e.source, e.record.sourceId)}
      onReject={() => e.record && onReject(e.source, e.record.sourceId)}
    />
  );
  return (
    <details className="from-each-source">
      <summary>
        From each source ({data.entries.length} {data.entries.length === 1 ? 'source' : 'sources'})
      </summary>
      {data.entries.length === 0 && (
        <p className="muted small">No source has been asked about this book yet.</p>
      )}
      {trusted.length > 0 && <ul className="plain source-list">{trusted.map(entry)}</ul>}
      {unconfirmed.length > 0 && (
        <>
          <p className="source-group">
            <strong>Unconfirmed — check these before trusting them</strong>
          </p>
          <ul className="plain source-list">{unconfirmed.map(entry)}</ul>
        </>
      )}
      {kind.length > 0 && (
        <p className="muted small">
          Not asked, because they don’t cover this kind of book:{' '}
          {kind.map((n) => n.label).join(', ')}.
        </p>
      )}
      {notSetUp.length > 0 && (
        <p className="muted small">
          Not set up, so not asked: {notSetUp.map((n) => n.label).join(', ')}. You can add them in
          Settings → Online sources.
        </p>
      )}
    </details>
  );
}
