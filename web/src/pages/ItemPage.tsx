import { useCallback, useEffect, useId, useState } from 'react';
import {
  api,
  ApiError,
  DNF_LABELS,
  FORMAT_LABELS,
  formatBytes,
  formatDate,
  KIND_LABELS,
  PDF_TYPE_LABELS,
  PROBLEM_LABELS,
  PROGRESS_LABELS,
  type DnfReason,
  type FileDetail,
  type ItemDetail,
  type Precision,
  type Progress,
  type UserData,
} from '../api.ts';
import { AvailabilityLabels, Cover, creatorsText, Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';
import { OnlineCard } from './OnlineCard.tsx';

type Patch = Partial<{
  progress: Progress;
  dnfReason: DnfReason | null;
  startedOn: string | null;
  startedPrecision: Precision | null;
  finishedOn: string | null;
  finishedPrecision: Precision | null;
  rating: number | null;
  note: string | null;
  takeaway: string | null;
  hidden: boolean;
  titleOverride: string | null;
  kindOverride: string | null;
  referenceOverride: boolean | null;
  icloudOverride: 'in' | 'not_in' | null;
  triage: 'want' | 'maybe' | 'never' | null;
  effortOverride: 'light' | 'medium' | 'heavy' | null;
}>;

export function ItemPage({ id }: { id: string }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItem(await api.get<ItemDetail>(`/api/items/${encodeURIComponent(id)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (item) document.title = `${item.title} · whatBooksNext`;
  }, [item]);

  const save = async (patch: Patch, message = 'Saved') => {
    try {
      setError(null);
      await api.patch(`/api/items/${item!.id}`, patch);
      await load();
      setSaved(message);
      window.setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !item)
    return (
      <div className="page">
        <Notice kind="error">{error}</Notice>
      </div>
    );
  if (!item)
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    );
  const u = item.user;

  return (
    <div className="page">
      <a
        className="back"
        href={hrefFor({ view: 'library' })}
        onClick={(e) => {
          if (window.history.length > 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            window.history.back();
          } else onLinkClick({ view: 'library' })(e);
        }}
      >
        ← Back
      </a>
      <div className="item-head">
        <Cover fileId={item.coverFileId} kind={item.kind} size="large" />
        <div className="item-head-text">
          <TitleEditor item={item} onSave={save} />
          {item.creators.length > 0 && <p className="byline">{creatorsText(item.creators)}</p>}
          {!u.titleOverride && (
            <p className="muted small">
              {item.titleSource === 'embedded'
                ? 'Title from the file’s own details.'
                : 'Title guessed from the filename.'}
            </p>
          )}
          <div className="item-meta big">
            <AvailabilityLabels a={item.availability} />
          </div>
        </div>
      </div>
      <div className="live" aria-live="polite">
        {saved && <span className="saved">✓ {saved}</span>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="detail-grid">
        <section aria-labelledby="progress-h" className="card">
          <h2 id="progress-h">Progress</h2>
          <ProgressButtons user={u} onSave={save} />
          {u.progress === 'dnf' && (
            <fieldset className="radio-row">
              <legend>Why? (optional — only “Not for me” counts as a dislike)</legend>
              {(Object.keys(DNF_LABELS) as DnfReason[]).map((r) => (
                <label key={r}>
                  <input
                    type="radio"
                    name="dnf"
                    checked={u.dnfReason === r}
                    onChange={() => void save({ dnfReason: r })}
                  />
                  {DNF_LABELS[r]}
                </label>
              ))}
              {u.dnfReason && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void save({ dnfReason: null })}
                >
                  No reason
                </button>
              )}
            </fieldset>
          )}
          <DateEditor
            key={`s-${u.startedOn}-${u.startedPrecision}`}
            label="Started"
            value={u.startedOn}
            precision={u.startedPrecision}
            onSave={(v, p) => save({ startedOn: v, startedPrecision: p })}
          />
          {u.progress === 'finished' && (
            <DateEditor
              key={`f-${u.finishedOn}-${u.finishedPrecision}`}
              label="Finished"
              value={u.finishedOn}
              precision={u.finishedPrecision}
              onSave={(v, p) => save({ finishedOn: v, finishedPrecision: p })}
            />
          )}
          <div className="field inline">
            <label htmlFor="rating">Your rating</label>
            <select
              id="rating"
              value={u.rating ?? ''}
              onChange={(e) =>
                void save({ rating: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">Not rated</option>
              {Array.from({ length: 10 }, (_, i) => 10 - i).map((n) => (
                <option key={n} value={n}>
                  {n} / 10
                </option>
              ))}
            </select>
          </div>
          <ShortlistToggle item={item} onChanged={load} />
        </section>

        <section aria-labelledby="notes-h" className="card">
          <h2 id="notes-h">Notes</h2>
          <TextEditor
            key={`n-${u.note}`}
            label="Note"
            multiline
            value={u.note}
            onSave={(v) => save({ note: v }, 'Note saved')}
          />
          {(item.kind === 'nonfiction' ||
            item.kind === 'self_help' ||
            item.kind === 'tech' ||
            u.takeaway) && (
            <TextEditor
              key={`t-${u.takeaway}`}
              label="Takeaway (one line)"
              value={u.takeaway}
              onSave={(v) => save({ takeaway: v }, 'Takeaway saved')}
            />
          )}
        </section>

        <section aria-labelledby="about-h" className="card">
          <h2 id="about-h">About this item</h2>
          <div className="field inline">
            <label htmlFor="kind">Kind</label>
            <select
              id="kind"
              value={u.kindOverride ?? ''}
              onChange={(e) => void save({ kindOverride: e.target.value || null })}
            >
              <option value="">
                {item.kind && !u.kindOverride ? `${KIND_LABELS[item.kind]} (guessed)` : 'Unknown'}
              </option>
              {Object.entries(KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={item.isReference}
              onChange={(e) => void save({ referenceOverride: e.target.checked })}
            />
            Reference book (dipped into, not read cover to cover)
          </label>
          <div className="field inline">
            <label htmlFor="icloud">In iCloud</label>
            <select
              id="icloud"
              value={u.icloudOverride ?? ''}
              onChange={(e) =>
                void save({ icloudOverride: (e.target.value || null) as 'in' | 'not_in' | null })
              }
            >
              <option value="">Same as its folder</option>
              <option value="in">Yes, I have it in iCloud</option>
              <option value="not_in">No, not in iCloud</option>
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="triage">Triage</label>
            <select
              id="triage"
              value={u.triage ?? ''}
              onChange={(e) =>
                void save({ triage: (e.target.value || null) as 'want' | 'maybe' | 'never' | null })
              }
            >
              <option value="">Not decided</option>
              <option value="want">Want</option>
              <option value="maybe">Maybe</option>
              <option value="never">Never (not recommended)</option>
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="effort">Effort</label>
            <select
              id="effort"
              value={u.effortOverride ?? ''}
              onChange={(e) =>
                void save({
                  effortOverride: (e.target.value || null) as 'light' | 'medium' | 'heavy' | null,
                })
              }
            >
              <option value="">Guess from its kind</option>
              <option value="light">Light</option>
              <option value="medium">Medium</option>
              <option value="heavy">Heavy</option>
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={u.hidden}
              onChange={(e) => void save({ hidden: e.target.checked })}
            />
            Hide from the library
          </label>
          {item.seriesHint && (
            <p className="muted small">
              Series (from the filename, unconfirmed): {item.seriesHint}
            </p>
          )}
        </section>
      </div>

      <OnlineCard itemId={item.id} onChanged={() => void load()} />

      <FromTheFile file={item.files.find((f) => f.isPrimary) ?? item.files[0]} />

      <section aria-labelledby="files-h">
        <h2 id="files-h">Files</h2>
        <ul className="file-list">
          {item.files.map((f) => (
            <FileRow key={f.id} file={f} onChanged={load} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function TitleEditor({
  item,
  onSave,
}: {
  item: ItemDetail;
  onSave: (p: Patch, m?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.title);
  if (!editing) {
    return (
      <div className="title-row">
        <h1>{item.title}</h1>
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            setValue(item.title);
            setEditing(true);
          }}
        >
          Fix title
        </button>
        {item.user.titleOverride && (
          <p className="muted small">
            Your title. From the files: “{item.factTitle}”.{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => void onSave({ titleOverride: null }, 'Title reset')}
            >
              Use that instead
            </button>
          </p>
        )}
      </div>
    );
  }
  return (
    <form
      className="title-row"
      onSubmit={async (e) => {
        e.preventDefault();
        await onSave(
          { titleOverride: value.trim() && value.trim() !== item.factTitle ? value.trim() : null },
          'Title saved',
        );
        setEditing(false);
      }}
    >
      <label htmlFor="title-input" className="visually-hidden">
        Title
      </label>
      <input
        id="title-input"
        className="title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit">Save title</button>
      <button type="button" className="secondary" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function ProgressButtons({
  user,
  onSave,
}: {
  user: UserData;
  onSave: (p: Patch, m?: string) => Promise<void>;
}) {
  return (
    <div className="bucket-row" role="group" aria-label="Progress">
      {(Object.keys(PROGRESS_LABELS) as Progress[]).map((p) => (
        <button
          key={p}
          type="button"
          className={`bucket ${user.progress === p ? 'on' : ''} ${p === 'dnf' ? 'dnf' : ''}`}
          aria-pressed={user.progress === p}
          onClick={() => void onSave({ progress: p }, PROGRESS_LABELS[p])}
        >
          {PROGRESS_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

function DateEditor({
  label,
  value,
  precision,
  onSave,
}: {
  label: string;
  value: string | null;
  precision: Precision | null;
  onSave: (value: string | null, precision: Precision | null) => Promise<void>;
}) {
  const id = useId();
  const [v, setV] = useState(value ?? '');
  const [p, setP] = useState<Precision | ''>(precision ?? '');
  const dirty = (value ?? '') !== v || (precision ?? '') !== p;
  return (
    <fieldset className="date-editor">
      <legend>{label}</legend>
      <div className="date-fields">
        <div className="field">
          <label htmlFor={`${id}-p`}>How sure?</label>
          <select id={`${id}-p`} value={p} onChange={(e) => setP(e.target.value as Precision | '')}>
            <option value="">Not recorded</option>
            <option value="exact">Exact date</option>
            <option value="approximate">Roughly</option>
            <option value="unknown">Don’t know when</option>
          </select>
        </div>
        {p !== 'unknown' && p !== '' && (
          <div className="field">
            <label htmlFor={`${id}-v`}>
              {p === 'exact' ? 'Date' : 'Year or month (e.g. 2019 or 2019-06)'}
            </label>
            <input
              id={`${id}-v`}
              type={p === 'exact' ? 'date' : 'text'}
              value={v}
              inputMode={p === 'exact' ? undefined : 'numeric'}
              pattern={p === 'exact' ? undefined : '\\d{4}(-\\d{2}(-\\d{2})?)?'}
              onChange={(e) => setV(e.target.value)}
            />
          </div>
        )}
        {dirty && (
          <button
            type="button"
            className="small"
            onClick={() => void onSave(p === 'unknown' || p === '' ? null : v || null, p || null)}
          >
            Save {label.toLowerCase()} date
          </button>
        )}
      </div>
    </fieldset>
  );
}

function TextEditor({
  label,
  value,
  multiline,
  onSave,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
  onSave: (v: string | null) => Promise<void>;
}) {
  const id = useId();
  const [v, setV] = useState(value ?? '');
  const dirty = v !== (value ?? '');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} rows={4} value={v} onChange={(e) => setV(e.target.value)} />
      ) : (
        <input id={id} value={v} onChange={(e) => setV(e.target.value)} />
      )}
      {dirty && (
        <div className="row-actions">
          <button type="button" className="small" onClick={() => void onSave(v.trim() || null)}>
            Save {label.split(' ')[0]!.toLowerCase()}
          </button>
          <button type="button" className="secondary small" onClick={() => setV(value ?? '')}>
            Undo changes
          </button>
        </div>
      )}
    </div>
  );
}

function ShortlistToggle({
  item,
  onChanged,
}: {
  item: ItemDetail;
  onChanged: () => Promise<void>;
}) {
  const on = item.user.shortlistPosition !== null;
  return (
    <button
      type="button"
      className={`secondary star-button ${on ? 'on' : ''}`}
      aria-pressed={on}
      onClick={async () => {
        if (on) await api.delete(`/api/shortlist/${item.id}`);
        else await api.post('/api/shortlist', { itemId: item.id });
        await onChanged();
      }}
    >
      <span aria-hidden="true">{on ? '★ ' : '☆ '}</span>
      {on ? `On shortlist (#${item.user.shortlistPosition})` : 'Add to shortlist'}
    </button>
  );
}

const FILE_STATE: Record<string, string> = {
  present: 'On this PC',
  placeholder: 'Online only — opening it will download it',
  unknown: 'Download state unknown',
  missing: 'Missing — not found in the last scan',
};

/**
 * What the primary file says about itself (§10). Text from files is untrusted: React renders it
 * as text, so a description containing HTML or a script tag shows as plain characters (§6.3).
 */
function FromTheFile({ file }: { file: FileDetail | undefined }) {
  const m = file?.metadata;
  if (!file || !m) return null;
  const rows: [string, string][] = [];
  if (m.title) rows.push(['Title', m.title]);
  if (m.creators?.length) rows.push(['By', creatorsText(m.creators)]);
  if (m.series) rows.push(['Series', m.seriesIndex ? `${m.series}, #${m.seriesIndex}` : m.series]);
  if (m.publisher) rows.push(['Publisher', m.publisher]);
  if (m.date) rows.push(['Date in the file', m.date]);
  if (m.language) rows.push(['Language', m.language]);
  const isbns = m.identifiers?.filter((i) => i.scheme === 'isbn').map((i) => i.value) ?? [];
  if (isbns.length) rows.push(['ISBN', isbns.join(', ')]);
  if (m.isbnCandidates?.length)
    rows.push(['ISBNs mentioned inside (unconfirmed)', m.isbnCandidates.slice(0, 5).join(', ')]);
  if (m.subjects?.length) rows.push(['Subjects', m.subjects.slice(0, 8).join(', ')]);
  if (rows.length === 0 && !m.description) return null;
  return (
    <section aria-labelledby="fromfile-h" className="card from-file">
      <h2 id="fromfile-h">From the file</h2>
      <p className="muted small">
        What {file.name} says about itself. Online lookups arrive in a later version.
      </p>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {m.description && <p className="description">{m.description}</p>}
    </section>
  );
}

function FileRow({ file, onChanged }: { file: FileDetail; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const act = async (action: 'open' | 'show', confirmDownload = false) => {
    setMessage(null);
    try {
      await api.post(
        `/api/files/${file.id}/${action}`,
        confirmDownload ? { confirmDownload: true } : {},
      );
      setConfirm(null);
      setMessage({
        kind: 'info',
        text: action === 'open' ? 'Opening in your default app…' : 'Showing it in File Explorer…',
      });
    } catch (e) {
      if (e instanceof ApiError && e.needsConfirmation) setConfirm(e.message);
      else setMessage({ kind: 'error', text: (e as Error).message });
    }
  };

  const details = [
    FORMAT_LABELS[file.format] ?? file.format.toUpperCase(),
    formatBytes(file.size),
    file.qualityTag && `Quality: ${file.qualityTag}`,
    file.editionNumber && `Edition ${file.editionNumber}`,
    file.editionNote,
    file.language && `Language: ${file.language}`,
    file.wordCount !== null && `${file.wordCount.toLocaleString()} words`,
    file.pageCount !== null && `${file.pageCount.toLocaleString()} pages`,
  ].filter(Boolean);

  const usable = file.folderReachable && file.availability !== 'missing';
  return (
    <li className="file-row">
      <div>
        <div className="file-name">
          {file.name} {file.isPrimary && <span className="tag">Primary</span>}
        </div>
        <div className="muted small path">
          {file.folderPath}
          {file.relPath.includes('/')
            ? ` › ${file.relPath.split('/').slice(0, -1).join(' › ')}`
            : ''}
        </div>
        <div className="small">{details.join(' · ')}</div>
        {file.problem && (
          <div className="small problem">
            <span aria-hidden="true">⚠ </span>
            {PROBLEM_LABELS[file.problem] ?? file.problem}
            {file.problemDetail ? `: ${file.problemDetail}` : ''}
          </div>
        )}
        {file.format === 'pdf' && file.pdfType && (
          <div className="small pdf-type">
            <label htmlFor={`pdftype-${file.id}`}>PDF type</label>{' '}
            <select
              id={`pdftype-${file.id}`}
              value={file.pdfTypeOverride ?? ''}
              onChange={async (e) => {
                try {
                  await api.patch(`/api/files/${file.id}`, {
                    pdfTypeOverride: e.target.value || null,
                  });
                  await onChanged();
                } catch (err) {
                  setMessage({ kind: 'error', text: (err as Error).message });
                }
              }}
            >
              <option value="">Detected: {PDF_TYPE_LABELS[file.pdfType] ?? file.pdfType}</option>
              <option value="comic">Comic</option>
              <option value="text">Text book</option>
              <option value="scanned">Scanned book</option>
            </select>
            {!file.pdfTypeOverride && file.pdfTypeEvidence && (
              <span className="muted"> {file.pdfTypeEvidence}</span>
            )}
            {file.pdfTypeOverride && <span className="muted"> (your correction)</span>}
          </div>
        )}
        <div className="small">
          {file.folderReachable
            ? (FILE_STATE[file.availability] ?? file.availability)
            : 'Folder not reachable (drive not connected?)'}
          {file.stale && ' · not re-checked in the last scan'} · first seen{' '}
          {formatDate(file.firstSeenAt)}
        </div>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="small"
          disabled={!usable}
          aria-label={`Open ${file.name}`}
          onClick={() => void act('open')}
        >
          Open
        </button>
        <button
          type="button"
          className="secondary small"
          disabled={!usable}
          aria-label={`Show ${file.name} in folder`}
          onClick={() => void act('show')}
        >
          Show in folder
        </button>
      </div>
      {confirm && (
        <div className="confirm" role="alertdialog" aria-label="Confirm download">
          <p>{confirm}</p>
          <button type="button" className="small" onClick={() => void act('open', true)}>
            Open and download
          </button>
          <button type="button" className="secondary small" onClick={() => setConfirm(null)}>
            Don’t open
          </button>
        </div>
      )}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
    </li>
  );
}
