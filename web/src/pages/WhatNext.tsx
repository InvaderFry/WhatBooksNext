import { useCallback, useEffect, useState } from 'react';
import { api, PROGRESS_LABELS, type Card, type ReadNext } from '../api.ts';
import {
  AvailabilityLabels,
  Cover,
  creatorsText,
  Formats,
  KindText,
  Notice,
} from '../components.tsx';
import { hrefFor, onLinkClick, updateParams, type Params } from '../url.ts';
import { LookupBanner } from './LookupBanner.tsx';

/**
 * What next (PLAN.md §13, §15): Read next with the time control, Ready to read, and cards that
 * say their scope, true reasons and limitations, with "Not this, because…" on each (§13.8).
 */

const MOOD_KEY = 'wbn:not-in-mood';

/** "Not in the mood" lasts until the tab closes (§13.8): kept in sessionStorage only. */
function notInMood(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(MOOD_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function addNotInMood(id: string) {
  try {
    sessionStorage.setItem(MOOD_KEY, JSON.stringify([...notInMood(), id]));
  } catch {
    /* private mode: the card is still hidden until the page reloads */
  }
}

export function WhatNext({ params, onChanged }: { params: Params; onChanged: () => void }) {
  const time = params.time ?? 'any';
  const mode = params.mode === 'finish_within' ? 'finish_within' : 'read_for';
  const ready = params.ready === '1';
  const show = (['books', 'tech', 'comics'] as const).find((x) => x === params.show) ?? 'all';
  const [data, setData] = useState<ReadNext | null>(null);
  const [extra, setExtra] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [hidden, setHidden] = useState<string[]>(notInMood);

  const query = useCallback(
    (offset: number) =>
      `/api/next?${new URLSearchParams({
        time,
        mode,
        ready: ready ? '1' : '',
        show: show === 'all' ? '' : show,
        exclude: hidden.join(','),
        offset: String(offset),
      }).toString()}`,
    [time, mode, ready, show, hidden],
  );

  const load = useCallback(async () => {
    try {
      setData(await api.get<ReadNext>(query(0)));
      setExtra([]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    const offset = (data?.cards.length ?? 0) + extra.length;
    const r = await api.get<ReadNext>(query(offset));
    setExtra((x) => [...x, ...r.cards]);
    setAnnounce(`${r.cards.length} more shown.`);
  };

  const cards = [...(data?.cards ?? []), ...extra];
  const budgetLabel = data?.presets.find((p) => p.id === time)?.label ?? 'Any length';

  return (
    <div className="page">
      <div className="page-head">
        <h1>What next</h1>
        <p className="muted">Picks from books you already own, with the reasons behind each.</p>
      </div>
      <LookupBanner onFinished={() => void load()} />
      <TriageOffer />

      <form className="time-control" onSubmit={(e) => e.preventDefault()} aria-label="Time">
        <fieldset className="segmented">
          <legend>How long have you got?</legend>
          {(data?.presets ?? []).map((p) => (
            <label key={p.id} className={time === p.id ? 'on' : ''}>
              <input
                type="radio"
                name="time"
                value={p.id}
                checked={time === p.id}
                onChange={() => updateParams({ time: p.id })}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="segmented">
          <legend>What kind?</legend>
          {(
            [
              ['books', 'Books'],
              ['tech', 'Tech'],
              ['comics', 'Comics and manga'],
              ['all', 'All'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className={show === id ? 'on' : ''}>
              <input
                type="radio"
                name="show"
                value={id}
                checked={show === id}
                onChange={() => updateParams({ show: id === 'all' ? '' : id })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="segmented" disabled={time === 'any'}>
          <legend>Do you want to…</legend>
          <label className={mode === 'read_for' ? 'on' : ''}>
            <input
              type="radio"
              name="mode"
              value="read_for"
              checked={mode === 'read_for'}
              onChange={() => updateParams({ mode: '' })}
            />
            Read for that long
          </label>
          <label className={mode === 'finish_within' ? 'on' : ''}>
            <input
              type="radio"
              name="mode"
              value="finish_within"
              checked={mode === 'finish_within'}
              onChange={() => updateParams({ mode: 'finish_within' })}
            />
            Finish something in that time
          </label>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={ready}
            onChange={(e) => updateParams({ ready: e.target.checked ? '1' : '' })}
          />
          Ready to read only
          <span className="muted small">
            {' '}
            (on this PC now, or somewhere you said you can read it)
          </span>
        </label>
        {time === 'evening' || time === 'weekend' ? (
          <p className="hint">
            {time === 'evening' ? 'An evening means 3 hours.' : 'A weekend means 10 hours.'}
          </p>
        ) : null}
      </form>

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data && (
        <p className="muted small coverage-line">
          {data.total} {data.total === 1 ? 'pick' : 'picks'}
          {mode === 'finish_within' && time !== 'any'
            ? ` you can finish within ${budgetLabel.toLowerCase()}`
            : ''}
          . Of {data.coverage.eligible} books to choose from, {data.coverage.rated} have a rating
          and {data.coverage.lengthKnown} a known length; the rest count as average.
          {data.hardcover === false && ' Adding a Hardcover token in Settings brings more ratings.'}
          {hidden.length > 0 && (
            <>
              {' '}
              {hidden.length} hidden for now.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  try {
                    sessionStorage.removeItem(MOOD_KEY);
                  } catch {
                    /* ignore */
                  }
                  setHidden([]);
                }}
              >
                Show them again
              </button>
            </>
          )}
        </p>
      )}
      {data && cards.length === 0 && (
        <Notice>
          {mode === 'finish_within' && time !== 'any'
            ? `Nothing has a measured length that fits in ${budgetLabel.toLowerCase()}. Try a longer time, or see “Might fit” below.`
            : data.coverage.eligible === 0
              ? 'Nothing to recommend yet. Add a folder and scan it, or check that books aren’t all marked finished or Never.'
              : 'Nothing matches these settings.'}
        </Notice>
      )}
      {cards.length > 0 && (
        <ol className="cards">
          {cards.map((c) => (
            <PickCard
              key={c.id}
              card={c}
              situation={{ time, mode, ready, show }}
              onDone={(msg, hide) => {
                setAnnounce(msg);
                if (hide) {
                  addNotInMood(c.id);
                  setHidden(notInMood());
                } else void load();
                onChanged();
              }}
            />
          ))}
        </ol>
      )}
      {data && cards.length < data.total && (
        <button type="button" className="secondary" onClick={() => void more()}>
          Show more
        </button>
      )}
      {data && data.mightFit.length > 0 && (
        <section className="section might-fit" aria-labelledby="might-h">
          <h2 id="might-h">Might fit</h2>
          <p className="muted">
            These could fit, but their length is a rough estimate, so they aren’t counted as a sure
            fit.
          </p>
          <ol className="cards">
            {data.mightFit.map((c) => (
              <PickCard
                key={c.id}
                card={c}
                situation={{ time, mode, ready, show }}
                onDone={(msg, hide) => {
                  setAnnounce(msg);
                  // The same as the main list: "Not in the mood" hides it for this tab.
                  if (hide) {
                    addNotInMood(c.id);
                    setHidden(notInMood());
                  } else void load();
                  onChanged();
                }}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

const REASONS: { id: string; label: string }[] = [
  { id: 'already_read', label: 'Already read' },
  { id: 'wrong_book', label: 'Wrong book' },
  { id: 'not_in_mood', label: 'Not in the mood' },
  { id: 'not_interested', label: 'Not interested' },
  { id: 'other', label: 'Other…' },
];

function PickCard({
  card,
  situation,
  onDone,
}: {
  card: Card;
  situation: object;
  onDone: (message: string, hideForSession?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [offerNever, setOfferNever] = useState(false);
  const [other, setOther] = useState<string | null>(null);
  const [shortlisted, setShortlisted] = useState(card.shortlisted);
  const headingId = `card-${card.id}`;

  const send = async (reason: string, note?: string) => {
    await api.post('/api/feedback', {
      itemId: card.id,
      reason,
      mode: 'read_next',
      situation,
      note,
    });
    if (reason === 'already_read') onDone(`${card.title} marked as read.`);
    else if (reason === 'wrong_book') onDone(`${card.title} sent to Needs review.`);
    else if (reason === 'not_in_mood')
      onDone(`${card.title} hidden until you close this tab.`, true);
    else if (reason === 'not_interested') setOfferNever(true);
    else onDone('Thanks — noted.', true);
    if (reason !== 'not_interested') setOpen(false);
  };

  return (
    <li className="card pick" aria-labelledby={headingId}>
      <Cover fileId={card.coverFileId} kind={card.kind} />
      <div className="pick-main">
        <h3 id={headingId}>
          <a
            href={hrefFor({ view: 'item', id: card.id })}
            onClick={onLinkClick({ view: 'item', id: card.id })}
          >
            {card.title}
          </a>
        </h3>
        <p className="item-meta">
          {card.creators.length > 0 && <span>{creatorsText(card.creators)}</span>}
          <span>
            <KindText item={{ kind: card.kind, isReference: false }} />
          </span>
          <span>
            <Formats formats={card.formats} />
          </span>
          {card.progress !== 'not_started' && <span>{PROGRESS_LABELS[card.progress]}</span>}
        </p>
        <p className="scope">
          <strong>{card.scope}</strong>
          {card.lengthBasis && <span className="muted small"> ({card.lengthBasis})</span>}
        </p>
        {card.reasons.length > 0 && (
          <ul className="reasons" aria-label="Why this pick">
            {card.reasons.map((r) => (
              <li key={r}>
                <span aria-hidden="true">✓ </span>
                {r}
              </li>
            ))}
          </ul>
        )}
        {card.limitations.length > 0 && (
          <p className="limits">
            <span aria-hidden="true">⚠ </span>
            <span className="visually-hidden">Limitations: </span>
            {card.limitations.join(' · ')}
          </p>
        )}
        <AvailabilityLabels a={{ ...card.availability, label: null }} />
        <div className="row-actions wrap">
          <button
            type="button"
            className={`secondary small star-button${shortlisted ? ' on' : ''}`}
            aria-pressed={shortlisted}
            onClick={async () => {
              if (shortlisted) await api.delete(`/api/shortlist/${card.id}`);
              else await api.post('/api/shortlist', { itemId: card.id });
              setShortlisted(!shortlisted);
            }}
          >
            <span aria-hidden="true">{shortlisted ? '★' : '☆'} </span>
            {shortlisted ? 'On shortlist' : 'Shortlist'}
          </button>
          <button
            type="button"
            className="secondary small"
            aria-expanded={open}
            aria-controls={`not-${card.id}`}
            onClick={() => setOpen(!open)}
          >
            Not this, because…
          </button>
        </div>
        {open && (
          <div className="not-this" id={`not-${card.id}`}>
            {!offerNever && other === null && (
              <div className="row-actions wrap" role="group" aria-label={`Why not ${card.title}?`}>
                {REASONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="small secondary"
                    onClick={() => (r.id === 'other' ? setOther('') : void send(r.id))}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
            {offerNever && (
              <div className="row-actions wrap">
                <span>Never recommend it again?</span>
                <button
                  type="button"
                  className="small"
                  onClick={async () => {
                    await api.patch(`/api/items/${card.id}`, { triage: 'never' });
                    onDone(`${card.title} marked Never.`);
                  }}
                >
                  Mark Never
                </button>
                <button
                  type="button"
                  className="small secondary"
                  onClick={() => onDone(`Noted. ${card.title} hidden for now.`, true)}
                >
                  Just hide it for now
                </button>
              </div>
            )}
            {other !== null && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send('other', other);
                }}
              >
                <label className="visually-hidden" htmlFor={`other-${card.id}`}>
                  Why not this one?
                </label>
                <input
                  id={`other-${card.id}`}
                  value={other}
                  maxLength={500}
                  placeholder="Why not this one?"
                  onChange={(e) => setOther(e.target.value)}
                />
                <button type="submit" className="small">
                  Send
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const OFFER_KEY = 'wbn:triage-offer-dismissed';

/** First run offers triage up front, never forces it (§13.5). */
function TriageOffer() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(OFFER_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (dismissed) return;
    void api
      .get<{ remaining: number; triaged: number }>('/api/triage?limit=0')
      .then((t) => setShow(t.triaged === 0 && t.remaining >= 5));
  }, []);
  if (!show) return null;
  return (
    <div className="notice offer">
      <strong>Sort 15 books to get better picks</strong> — Want, Maybe, Never or Already read. Takes
      a few minutes.{' '}
      <a href={hrefFor({ view: 'triage' })} onClick={onLinkClick({ view: 'triage' })}>
        Start triage
      </a>{' '}
      or{' '}
      <button
        type="button"
        className="link-button"
        onClick={() => {
          try {
            localStorage.setItem(OFFER_KEY, '1');
          } catch {
            /* ignore */
          }
          setShow(false);
        }}
      >
        skip
      </button>
      .
    </div>
  );
}
