import { useCallback, useEffect, useState } from 'react';
import {
  api,
  PROGRESS_LABELS,
  type Card,
  type ModeId,
  type ReadNext,
  type TriageList,
} from '../api.ts';
import {
  AvailabilityLabels,
  StoreLinks,
  Cover,
  creatorsText,
  Formats,
  KindText,
  Notice,
} from '../components.tsx';
import { hrefFor, onLinkClick, updateParams, type Params } from '../url.ts';
import { LookupBanner } from './LookupBanner.tsx';
import { GapNotice } from './SeriesCard.tsx';

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

const MODE_KEY = 'wbn:surprise-last';

export function WhatNext({ params, onChanged }: { params: Params; onChanged: () => void }) {
  const view = (params.m as ModeId | undefined) ?? 'read_next';
  const time = params.time ?? 'any';
  const mode = params.mode === 'finish_within' ? 'finish_within' : 'read_for';
  const ready = params.ready === '1';
  const complete = params.complete === '1';
  const mood = (['escape', 'learn', 'skim'] as const).find((x) => x === params.mood) ?? 'escape';
  const topic = params.topic ?? '';
  const show = (['books', 'tech', 'comics'] as const).find((x) => x === params.show) ?? 'all';
  const [data, setData] = useState<ReadNext | null>(null);
  const [extra, setExtra] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [hidden, setHidden] = useState<string[]>(notInMood);
  // Surprise me: the pick just shown, so a reroll never repeats it straight away.
  const [previous, setPrevious] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(MODE_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const [roll, setRoll] = useState(0);

  const query = useCallback(
    (offset: number) =>
      `/api/next?${new URLSearchParams({
        view,
        time,
        mode,
        ready: ready ? '1' : '',
        complete: complete ? '1' : '',
        mood: view === 'mood' ? mood : '',
        topic,
        show: show === 'all' ? '' : show,
        exclude: hidden.join(','),
        previous: view === 'surprise' ? previous.join(',') : '',
        offset: String(offset),
      }).toString()}`,
    // `roll` asks for a new surprise pick without anything else changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, time, mode, ready, complete, mood, topic, show, hidden, roll],
  );

  const load = useCallback(async () => {
    try {
      const r = await api.get<ReadNext>(query(0));
      setData(r);
      setExtra([]);
      setError(null);
      if (r.view === 'surprise' && r.cards[0]) {
        const ids = [r.cards[0].id];
        setPrevious(ids);
        try {
          sessionStorage.setItem(MODE_KEY, JSON.stringify(ids));
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    const offset = (data?.cards.length ?? 0) + extra.length;
    let r: ReadNext;
    try {
      r = await api.get<ReadNext>(query(offset));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setExtra((x) => [...x, ...r.cards]);
    setAnnounce(`${r.cards.length} more shown.`);
  };

  const cards = [...(data?.cards ?? []), ...extra];
  const info = data?.modes.find((m) => m.id === view);
  const usesTime = info?.usesTime ?? true;
  const oneSitting = view === 'one_sitting';
  const finishing = (mode === 'finish_within' || oneSitting) && (time !== 'any' || oneSitting);
  const budgetLabel =
    oneSitting && time === 'any'
      ? '2 hours'
      : (data?.presets.find((p) => p.id === time)?.label ?? 'Any length');
  const situation = { view, time, mode, ready, show, complete, mood, topic };

  const onDone = (c: Card) => (msg: string, hide?: boolean) => {
    setAnnounce(msg);
    if (hide) {
      addNotInMood(c.id);
      setHidden(notInMood());
    } else void load();
    onChanged();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>What next</h1>
        <p className="muted">Picks from books you already own, with the reasons behind each.</p>
      </div>
      <LookupBanner onFinished={() => void load()} />
      <TriageOffer />
      <NewArrivalsOffer />
      {data && data.stillReading > 0 && view !== 'continue' && (
        <div className="offer">
          <strong>
            {data.stillReading} {data.stillReading === 1 ? 'book hasn’t' : 'books haven’t'} been
            touched in 3 months.
          </strong>{' '}
          Still reading {data.stillReading === 1 ? 'it' : 'them'}?{' '}
          <a
            href={hrefFor({ ...params, view: 'next', m: 'continue' })}
            onClick={onLinkClick({ ...params, view: 'next', m: 'continue' })}
          >
            Review {data.stillReading === 1 ? 'it' : 'them'}
          </a>
        </div>
      )}

      <form className="time-control" onSubmit={(e) => e.preventDefault()} aria-label="Choices">
        <fieldset className="segmented modes">
          <legend>What are you after?</legend>
          {(data?.modes ?? []).map((m) => (
            <label key={m.id} className={view === m.id ? 'on' : ''}>
              <input
                type="radio"
                name="m"
                value={m.id}
                checked={view === m.id}
                onChange={() => updateParams({ m: m.id === 'read_next' ? '' : m.id })}
              />
              {m.label}
            </label>
          ))}
        </fieldset>
        {info && <p className="mode-rule">{info.description}</p>}
        {view === 'mood' && data && (
          <fieldset className="segmented">
            <legend>Which mood?</legend>
            {data.moods.map((x) => (
              <label key={x.id} className={mood === x.id ? 'on' : ''}>
                <input
                  type="radio"
                  name="mood"
                  value={x.id}
                  checked={mood === x.id}
                  onChange={() => updateParams({ mood: x.id === 'escape' ? '' : x.id })}
                />
                {x.label} <span className="sub">· {x.description}</span>
              </label>
            ))}
          </fieldset>
        )}
        {usesTime && (
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
                {oneSitting && p.id === 'any' ? '2 h (one sitting)' : p.label}
              </label>
            ))}
          </fieldset>
        )}
        {view !== 'still_relevant' && (
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
        )}
        {usesTime && !oneSitting && (
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
        )}
        <div className="pick-filters">
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
          {view !== 'continue' && view !== 'still_relevant' && (
            <label className="check">
              <input
                type="checkbox"
                checked={complete}
                onChange={(e) => updateParams({ complete: e.target.checked ? '1' : '' })}
              />
              Complete stories only
              <span className="muted small">
                {' '}
                (standalone books, and finished series you own every part of)
              </span>
            </label>
          )}
          {data && data.topics.length > 0 && view !== 'still_relevant' && (
            <label className="topic-pick">
              Topic{' '}
              <select value={topic} onChange={(e) => updateParams({ topic: e.target.value })}>
                <option value="">Any topic</option>
                {data.topics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {usesTime && (time === 'evening' || time === 'weekend') ? (
          <p className="hint">
            {time === 'evening' ? 'An evening means 3 hours.' : 'A weekend means 10 hours.'}
          </p>
        ) : null}
      </form>

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {view === 'continue' && (
        <StillReadingDigest
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      )}
      {data && view !== 'surprise' && (
        <p className="muted small coverage-line">
          {data.total} {data.total === 1 ? 'pick' : 'picks'}
          {finishing ? ` you can finish within ${budgetLabel.toLowerCase()}` : ''}. Of{' '}
          {data.coverage.eligible} books to choose from, {data.coverage.rated}{' '}
          {data.coverage.rated === 1 ? 'has' : 'have'} a rating and {data.coverage.lengthKnown} a
          known length; the rest count as average.
          {data.hardcover === false && ' Adding a Hardcover token in Settings brings more ratings.'}
          {data.taste.on && ' Taste learning is on.'}{' '}
          <a href={hrefFor({ view: 'tune' })} onClick={onLinkClick({ view: 'tune' })}>
            Tune
          </a>
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
      {data?.leftOut && data.leftOut.ongoing + data.leftOut.unknown + data.leftOut.missing > 0 && (
        <p className="muted small">
          Left out as not complete:{' '}
          {[
            data.leftOut.ongoing && `${data.leftOut.ongoing} with the story ongoing`,
            data.leftOut.missing && `${data.leftOut.missing} with installments missing`,
            data.leftOut.unknown && `${data.leftOut.unknown} not known to be finished`,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      )}
      {data && cards.length === 0 && (
        <Notice>
          {data.coverage.eligible === 0 && view === 'read_next'
            ? 'Nothing to recommend yet. Add a folder and scan it, or check that books aren’t all marked finished or Never.'
            : (view === 'read_next' || view === 'mood') && finishing
              ? `Nothing has a measured length that fits in ${budgetLabel.toLowerCase()}. Try a longer time, or see “Might fit” below.`
              : (data.empty ?? 'Nothing matches these settings.')}
        </Notice>
      )}
      {view === 'surprise' && cards[0] && (
        <div className="row-actions wrap surprise-actions">
          <button type="button" onClick={() => setRoll((n) => n + 1)}>
            Reroll
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              addNotInMood(cards[0]!.id);
              setHidden(notInMood());
              setAnnounce(`${cards[0]!.title} hidden for today.`);
            }}
          >
            Not today
          </button>
          <span className="muted small">
            From your top {data?.total ?? 0}. Not today hides it until you close this tab.
          </span>
        </div>
      )}
      {cards.length > 0 && (
        // Cards are h3s under this heading, so headings don't jump from h1 to h3.
        <h2 id="picks-list-h" className="visually-hidden">
          Picks
        </h2>
      )}
      {cards.length > 0 && (
        <ol className="cards" aria-labelledby="picks-list-h">
          {cards.map((c) =>
            view === 'still_relevant' ? (
              <RelevanceCard key={c.id} card={c} onDone={onDone(c)} />
            ) : (
              <PickCard key={c.id} card={c} mode={view} situation={situation} onDone={onDone(c)} />
            ),
          )}
        </ol>
      )}
      {data && view !== 'surprise' && cards.length < data.total && (
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
              <PickCard key={c.id} card={c} mode={view} situation={situation} onDone={onDone(c)} />
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
  mode,
  situation,
  onDone,
}: {
  card: Card;
  mode: ModeId;
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
      mode,
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
      <Cover fileId={card.coverFileId} itemId={card.coverItemId} kind={card.kind} />
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
        {card.series && (
          <GapNotice
            gaps={card.gaps}
            seriesId={card.series.id}
            itemId={card.id}
            onMarked={(msg) => onDone(msg)}
          />
        )}
        <AvailabilityLabels a={{ ...card.availability, label: null }} />
        <div className="row-actions wrap">
          {/* A store copy's link: the main action when no file is here to open. */}
          <StoreLinks
            a={card.availability}
            title={card.title}
            primary={card.availability.state !== 'present'}
          />
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

/** Still relevant? (§13.10): the signals as context, and the owner decides. */
function RelevanceCard({
  card,
  onDone,
}: {
  card: Card;
  onDone: (message: string, hideForSession?: boolean) => void;
}) {
  const headingId = `card-${card.id}`;
  const act = async (action: string, msg: string) => {
    await api.post(`/api/items/${card.id}/relevance`, { action });
    onDone(msg);
  };
  return (
    <li className="card pick" aria-labelledby={headingId}>
      <Cover fileId={card.coverFileId} itemId={card.coverItemId} kind={card.kind} />
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
            <Formats formats={card.formats} />
          </span>
          {card.deferred && <span>Put off for later</span>}
        </p>
        <ul className="signals" aria-label="Signals to consider">
          {(card.signals ?? []).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <div className="row-actions wrap" role="group" aria-label={`Decide on ${card.title}`}>
          <button
            type="button"
            className="small"
            onClick={() => void act('want', `${card.title}: Want.`)}
          >
            Want
          </button>
          <button
            type="button"
            className="small secondary"
            onClick={() => void act('reference', `${card.title} marked as reference.`)}
          >
            Mark as reference
          </button>
          <button
            type="button"
            className="small secondary danger"
            onClick={() => void act('never', `${card.title}: Never.`)}
          >
            Never
          </button>
          {!card.deferred && (
            <button
              type="button"
              className="small secondary"
              onClick={() => void act('later', `${card.title} moved to the end of the list.`)}
            >
              Decide later
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

interface StalledItem extends Card {
  lastTouched: string | null;
}

/** Still reading? (§13.6): one digest of books untouched for 3 months, never a stream of prompts. */
function StillReadingDigest({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<StalledItem[] | null>(null);
  const [dnfFor, setDnfFor] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems((await api.get<{ items: StalledItem[] }>('/api/still-reading')).items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!items || items.length === 0) return null;
  const answer = async (id: string, action: string, dnfReason?: string | null) => {
    await api.post(`/api/still-reading/${id}`, { action, dnfReason });
    setDnfFor(null);
    await load();
    onChanged();
  };
  return (
    <section className="section digest" aria-labelledby="digest-h">
      <h2 id="digest-h">
        Still reading? {items.length} {items.length === 1 ? 'book hasn’t' : 'books haven’t'} been
        touched in 3 months
      </h2>
      <ul className="digest-list">
        {items.map((i) => (
          <li key={i.id}>
            <div>
              <a
                href={hrefFor({ view: 'item', id: i.id })}
                onClick={onLinkClick({ view: 'item', id: i.id })}
              >
                {i.title}
              </a>{' '}
              <span className="muted small">
                {PROGRESS_LABELS[i.progress]}
                {i.lastTouched && ` · last touched ${i.lastTouched.slice(0, 10)}`}
              </span>
            </div>
            {dnfFor === i.id ? (
              <div className="row-actions wrap" role="group" aria-label={`Why stop ${i.title}?`}>
                <span>Why?</span>
                {(
                  [
                    ['not_for_me', 'Not for me'],
                    ['not_now', 'Not now'],
                    ['too_difficult', 'Too difficult right now'],
                    [null, 'Skip the reason'],
                  ] as const
                ).map(([r, label]) => (
                  <button
                    key={label}
                    type="button"
                    className="small secondary"
                    onClick={() => void answer(i.id, 'dnf', r)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <div
                className="row-actions wrap"
                role="group"
                aria-label={`Still reading ${i.title}?`}
              >
                <button type="button" className="small" onClick={() => void answer(i.id, 'still')}>
                  Still reading
                </button>
                <button
                  type="button"
                  className="small secondary"
                  onClick={() => void answer(i.id, 'snooze')}
                >
                  Snooze 30 days
                </button>
                <button
                  type="button"
                  className="small secondary"
                  onClick={() => void answer(i.id, 'not_started')}
                >
                  Back to not started
                </button>
                <button type="button" className="small secondary" onClick={() => setDnfFor(i.id)}>
                  Did not finish
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const ARRIVALS_KEY = 'wbn:arrivals-dismissed';

/** After a scan finds new items: "12 new items — triage them?" (§13.5). Once per scan. */
function NewArrivalsOffer() {
  const [offer, setOffer] = useState<{ run: string; count: number } | null>(null);
  useEffect(() => {
    void api.get<TriageList>('/api/triage?limit=0').then((t) => {
      let dismissed: string | null = null;
      try {
        dismissed = localStorage.getItem(ARRIVALS_KEY);
      } catch {
        /* ignore */
      }
      // The first scan's books aren't new arrivals (the server leaves them out): the first-run
      // offer covers those.
      if (t.lastScan && t.lastScan.newItems > 0 && dismissed !== t.lastScan.id)
        setOffer({ run: t.lastScan.id, count: t.lastScan.newItems });
    });
  }, []);
  if (!offer) return null;
  return (
    <div className="offer">
      <strong>
        {offer.count} new {offer.count === 1 ? 'item' : 'items'} since the last scan
      </strong>{' '}
      — triage {offer.count === 1 ? 'it' : 'them'}?{' '}
      <a
        href={hrefFor({ view: 'triage', source: 'new' })}
        onClick={onLinkClick({ view: 'triage', source: 'new' })}
      >
        Triage new arrivals
      </a>{' '}
      or{' '}
      <button
        type="button"
        className="link-button"
        onClick={() => {
          try {
            localStorage.setItem(ARRIVALS_KEY, offer.run);
          } catch {
            /* ignore */
          }
          setOffer(null);
        }}
      >
        not now
      </button>
      .
    </div>
  );
}
