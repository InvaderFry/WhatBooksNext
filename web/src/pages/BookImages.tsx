import { useRef, useState } from 'react';
import type { PagePreviewFile } from '../../../server/src/lib/pagePreviews.ts';
import { api } from '../api.ts';

/** Shared, labelled enlargement for both local pages and source covers. */
export function BookImage({
  url,
  label,
  caption,
}: {
  url: string;
  label: string;
  caption?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="muted small">{label}: image unavailable</span>;
  return (
    <>
      <button
        type="button"
        className="book-image-button"
        onClick={() => dialog.current?.showModal()}
        aria-label={`Enlarge ${label}`}
      >
        <img
          src={url}
          alt={label}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
        <span className="small">{caption ?? label}</span>
      </button>
      <dialog ref={dialog} className="book-image-dialog" aria-label={label}>
        <form method="dialog">
          <button type="submit">Close image</button>
        </form>
        <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" />
      </dialog>
    </>
  );
}

export function BookPagePreviews({ itemId }: { itemId: string }) {
  const [files, setFiles] = useState<PagePreviewFile[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = files?.find((f) => f.id === selected) ?? files?.[0];
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.get<{ files: PagePreviewFile[] }>(
        `/api/items/${encodeURIComponent(itemId)}/page-previews`,
      );
      setFiles(result.files);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<PagePreviewFile>(
        `/api/files/${encodeURIComponent(file.id)}/page-previews`,
      );
      setFiles((old) => old?.map((f) => (f.id === updated.id ? updated : f)) ?? [updated]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="book-page-previews"
      onToggle={(e) => {
        if (e.currentTarget.open && files === null && !busy) void load();
      }}
    >
      <summary>Your copy: first two pages</summary>
      <p className="muted small">
        Compare these with the online covers below. Select any image to enlarge it. Covers can vary
        between editions.
      </p>
      {busy && <p role="status">Loading page previews…</p>}
      {error && (
        <p role="alert" className="warn">
          {error}
        </p>
      )}
      {error && !files && (
        <button type="button" className="secondary small" onClick={() => void load()}>
          Try again
        </button>
      )}
      {files?.length === 0 && (
        <p className="muted small">
          This imported or store book has no local file, so local pages are unavailable. You can
          still compare the online covers.
        </p>
      )}
      {files && files.length > 1 && (
        <label>
          Local file{' '}
          <select
            value={file?.id}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              setError(null);
            }}
          >
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {file && (
        <>
          <p className="small preview-filename">{file.name}</p>
          {file.note && <p className="muted small">{file.note}</p>}
          {file.pages.length > 0 && (
            <div className="book-images">
              {file.pages.map((p) => (
                <BookImage key={p.url} url={p.url} label={`Your copy — ${p.label}`} />
              ))}
            </div>
          )}
          {file.supported && file.pages.length === 0 && (
            <>
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() => void generate()}
              >
                Generate page previews
              </button>
              <p className="muted small">
                Reads only a downloaded local file, then saves the previews for later. Connect its
                drive if needed.
              </p>
            </>
          )}
        </>
      )}
    </details>
  );
}
