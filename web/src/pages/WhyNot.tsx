import { useEffect, useId, useState } from 'react';
import { api, type ItemSummary, type WhyFix, type WhyNot as WhyNotData } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick, updateParams } from '../url.ts';

/**
 * "Why isn't this book shown?" (feature review, step 5). Asks the server, which walks the same
 * steps What next is built from (`server/src/lib/whyNot.ts`), and shows each reason with its way
 * round. On What next it uses the current choices and a fix changes them in place; on a book's
 * page it checks plain Read next and a fix opens What next with that change.
 */

/** The explanation for one book, as a list of reasons with their one-tap fixes. */
function Explanation({
  r,
  onWhatNext,
  nextQuery,
}: {
  r: WhyNotData;
  onWhatNext: boolean;
  nextQuery: string;
}) {
  const fixButton = (f: WhyFix) => {
    if (f.kind === 'item')
      return (
        <a
          href={hrefFor({ view: 'item', id: f.id })}
          onClick={onLinkClick({ view: 'item', id: f.id })}
        >
          {f.label}
        </a>
      );
    if (onWhatNext)
      return (
        <button
          type="button"
          className="small secondary"
          onClick={() => updateParams({ [f.key]: f.value })}
        >
          {f.label}
        </button>
      );
    const params = {
      ...Object.fromEntries(new URLSearchParams(nextQuery)),
      view: 'next',
      [f.key]: f.value,
    };
    return (
      <a href={hrefFor(params)} onClick={onLinkClick(params)}>
        {f.label} in What next
      </a>
    );
  };

  if (r.position !== null && r.reasons.length === 0)
    return (
      <Notice kind="success">
        “{r.title}” is number {r.position} in this list.
      </Notice>
    );
  return (
    <div className="why-not">
      <p>
        <strong>{r.title}</strong>
        {r.position !== null ? ` is number ${r.position} in this list.` : ' isn’t shown because:'}
      </p>
      <ul>
        {r.reasons.map((x) => (
          <li key={x.text}>
            {x.text} {x.fix && <span className="why-fix">{fixButton(x.fix)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** On What next: find any book and see why it isn't in the list as it is now. */
export function WhyNotFinder({ nextQuery }: { nextQuery: string }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ItemSummary[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [r, setR] = useState<WhyNotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  // Re-ask whenever the choices change (a fix was just applied, or the owner changed them).
  useEffect(() => {
    if (!chosen) return;
    let stale = false;
    api
      .get<WhyNotData>(`/api/next/why?${nextQuery}&id=${encodeURIComponent(chosen)}`)
      .then((x) => !stale && (setR(x), setError(null)))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [chosen, nextQuery]);

  return (
    <details className="why-not-finder">
      <summary>Why isn’t a book here?</summary>
      <form
        className="row-actions wrap"
        role="search"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const x = await api.get<{ items: ItemSummary[] }>(
              `/api/items?q=${encodeURIComponent(q.trim())}&limit=8&hidden=1`,
            );
            setFound(x.items);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label htmlFor={inputId}>Find the book</label>
        <input
          id={inputId}
          type="search"
          value={q}
          placeholder="Title, author or series"
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="small" disabled={!q.trim()}>
          Search
        </button>
      </form>
      {found && found.length === 0 && <p className="muted small">Nothing matches that.</p>}
      {found && found.length > 0 && (
        <ul className="plain-list why-found">
          {found.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className="link-button"
                aria-pressed={chosen === i.id}
                onClick={() => {
                  setChosen(i.id);
                  setR(null);
                }}
              >
                {i.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div aria-live="polite">
        {r && chosen === r.id && <Explanation r={r} onWhatNext nextQuery={nextQuery} />}
      </div>
    </details>
  );
}

/** On a book's page: is it in Read next, and if not, why. Asked only when the owner wants. */
export function WhyNotForItem({ itemId }: { itemId: string }) {
  const [r, setR] = useState<WhyNotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card" aria-labelledby="why-not-h">
      <h2 id="why-not-h">In What next?</h2>
      {!r && (
        <button
          type="button"
          className="small secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setR(await api.get<WhyNotData>(`/api/next/why?id=${encodeURIComponent(itemId)}`));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : 'Is it recommended? Check Read next'}
        </button>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div aria-live="polite">{r && <Explanation r={r} onWhatNext={false} nextQuery="" />}</div>
    </section>
  );
}
