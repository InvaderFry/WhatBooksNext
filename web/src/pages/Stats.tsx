import { useEffect, useState } from 'react';
import { api, DNF_LABELS, KIND_LABELS, type DnfReason, type Kind, type Tune } from '../api.ts';
import { LoadError } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/**
 * Stats (PLAN.md §15). Facts — what you marked and what your files say — come first; the
 * estimates (reading time) are in their own section, labelled as estimates. Every rate shows
 * what it is out of, and a finish without a date is counted in no year.
 */

interface Count {
  key: string;
  count: number;
}
interface BacklogKind {
  kind: string;
  items: number;
  inProgress: number;
  withLength: number;
  low: number;
  high: number;
}
interface RateRow {
  key: string;
  label: string;
  finished: number;
  owned: number;
}
interface StatsData {
  today: string;
  library: {
    owned: number;
    readElsewhere: number;
    reference: number;
    never: number;
    hidden: number;
  };
  coverage: {
    kind: string;
    items: number;
    rated: number;
    lengthKnown: number;
    seriesKnown: number;
  }[];
  backlog: {
    byKind: BacklogKind[];
    total: BacklogKind;
    leftOut: { never: number; reference: number };
  };
  finishes: {
    total: number;
    byYear: { year: number; finished: number; byKind: Count[] }[];
    undated: number;
    thisYear: number;
    lastYear: number;
    lastYearToDate: number;
    lastYearUnplaced: number;
    readElsewhere: number;
  };
  readRate: { byKind: RateRow[]; byFolder: RateRow[] };
  dnf: { total: number; byReason: Count[] };
  never: { total: number; byKind: Count[] };
  ratings: { count: number; mean: number | null; distribution: Count[] };
  takeaways: { id: string; title: string; takeaway: string; finishedOn: string | null }[];
  taste: Tune['taste'];
  matches: {
    byBand: {
      accepted: number;
      provisional: number;
      tie: number;
      unidentified: number;
      notLookedUp: number;
      noSourceYet: number;
    };
    labelled: { confirmed: number; rejected: number; wrongHighConfidence: number };
  };
}

const kindLabel = (k: string) => KIND_LABELS[k as Kind] ?? 'Kind unknown';
const n = (x: number) => x.toLocaleString();
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const books = (x: number) => `${n(x)} ${x === 1 ? 'book' : 'books'}`;

/** Time as a range: "about 120–180 hours", or minutes under an hour ("about 20–30 minutes"). */
function hours(low: number, high: number): string {
  if (high < 60) {
    const m = (x: number) => Math.max(5, Math.round(x / 5) * 5);
    return m(low) === m(high) ? `about ${m(low)} minutes` : `about ${m(low)}–${m(high)} minutes`;
  }
  const r = (m: number) => (m < 600 ? Math.round(m / 6) / 10 : Math.round(m / 60));
  const a = r(low);
  const b = r(high);
  return a === b ? `about ${n(a)} hours` : `about ${n(a)}–${n(b)} hours`;
}

export function Stats() {
  const [s, setS] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api
      .get<StatsData>('/api/stats')
      .then(setS)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  if (error)
    return (
      <div className="page narrow">
        <div className="page-head">
          <h1>Stats</h1>
        </div>
        <LoadError message={error} onRetry={load} />
      </div>
    );
  if (!s)
    return (
      <div className="page narrow">
        <p className="muted">Loading…</p>
      </div>
    );

  const f = s.finishes;
  const year = Number(s.today.slice(0, 4));
  const maxRating = Math.max(1, ...s.ratings.distribution.map((d) => d.count));

  return (
    <div className="page narrow stats">
      <div className="page-head">
        <h1>Stats</h1>
        <p className="muted">
          Facts first: what you’ve marked and what your files say. Reading times are estimates and
          are shown apart.
        </p>
      </div>

      <section className="section" aria-labelledby="lib-h">
        <h2 id="lib-h">Your library</h2>
        <ul className="stat-tiles">
          <li>
            <strong>{n(s.library.owned)}</strong> books you own
          </li>
          <li>
            <strong>{n(f.total)}</strong> finished
          </li>
          <li>
            <strong>{n(s.backlog.total.items)}</strong> waiting to be read
          </li>
          <li>
            <strong>{n(s.library.readElsewhere)}</strong> read elsewhere
          </li>
        </ul>
        <p className="muted small">
          Waiting to be read leaves out {books(s.backlog.leftOut.never)} marked Never and{' '}
          {books(s.backlog.leftOut.reference)} kept as reference; they stay in your Library.
          {s.library.hidden > 0 && ` ${books(s.library.hidden)} hidden.`}
        </p>
      </section>

      <section className="section" aria-labelledby="fin-h">
        <h2 id="fin-h">Finished</h2>
        <p>
          <strong>{books(f.thisYear)}</strong> so far in {year}. In {year - 1}: {books(f.lastYear)}{' '}
          in the whole year
          {f.lastYear > 0 && (
            <>
              , {n(f.lastYearToDate)} by this date
              {f.lastYearUnplaced > 0 &&
                ` (and ${n(f.lastYearUnplaced)} whose date is too rough to place)`}
            </>
          )}
          .
        </p>
        {f.byYear.length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Books finished each year</caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Finished</th>
                <th scope="col">By kind</th>
              </tr>
            </thead>
            <tbody>
              {f.byYear.map((y) => (
                <tr key={y.year}>
                  <th scope="row">{y.year}</th>
                  <td>{n(y.finished)}</td>
                  <td>{y.byKind.map((k) => `${kindLabel(k.key)} ${n(k.count)}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {f.undated > 0 && (
          <p className="muted small">
            {books(f.undated)} finished on a date you didn’t record. They aren’t counted in any
            year.
          </p>
        )}
        {f.readElsewhere > 0 && (
          <p className="muted small">Includes {books(f.readElsewhere)} you read elsewhere.</p>
        )}
      </section>

      <section className="section" aria-labelledby="rate-h">
        <h2 id="rate-h">How much you’ve read of what you own</h2>
        <RateTable caption="Read rate by kind" head="Kind" rows={s.readRate.byKind} kind />
        {s.readRate.byFolder.length > 0 && (
          <RateTable caption="Read rate by folder" head="Folder" rows={s.readRate.byFolder} />
        )}
        <p className="muted small">
          Out of the books you own, counting each book once however many files or copies it has. A
          book can be in more than one folder.
        </p>
      </section>

      <section className="section" aria-labelledby="dnf-h">
        <h2 id="dnf-h">Stopped and set aside</h2>
        <p>
          Did not finish: <strong>{n(s.dnf.total)}</strong>
          {s.dnf.byReason.length > 0 &&
            ` — ${s.dnf.byReason
              .map(
                (r) =>
                  `${r.key === 'no_reason' ? 'no reason given' : DNF_LABELS[r.key as DnfReason]} ${n(r.count)}`,
              )
              .join(' · ')}`}
        </p>
        <p>
          Marked Never: <strong>{n(s.never.total)}</strong>
          {s.never.byKind.length > 0 &&
            ` — ${s.never.byKind.map((k) => `${kindLabel(k.key)} ${n(k.count)}`).join(' · ')}`}
        </p>
      </section>

      <section className="section" aria-labelledby="ratings-h">
        <h2 id="ratings-h">Your ratings</h2>
        {s.ratings.count === 0 ? (
          <p className="muted">You haven’t rated any books yet.</p>
        ) : (
          <>
            <p>
              {books(s.ratings.count)} rated, {s.ratings.mean} out of 10 on average.
            </p>
            <table className="table rating-bars">
              <caption className="visually-hidden">How many books you gave each rating</caption>
              <thead>
                <tr>
                  <th scope="col">Rating</th>
                  <th scope="col">Books</th>
                </tr>
              </thead>
              <tbody>
                {[...s.ratings.distribution].reverse().map((d) => (
                  <tr key={d.key}>
                    <th scope="row">{d.key}</th>
                    <td>
                      <span className="bar-cell">
                        <span
                          className="bar"
                          aria-hidden="true"
                          style={{ width: `${(d.count / maxRating) * 100}%` }}
                        />
                        <span>{n(d.count)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="section" aria-labelledby="est-h">
        <h2 id="est-h">
          Estimates <span className="tag">estimate</span>
        </h2>
        <p className="muted small">
          Reading time comes from word and page counts at assumed reading speeds, give or take 20%.
          The time adds up only the books whose length is known; for books you’ve started, only
          what’s left (roughly, from where you said you are).
        </p>
        <table className="table">
          <caption className="visually-hidden">
            Backlog by kind, with estimated reading time
          </caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Estimated time</th>
              <th scope="col">Waiting</th>
              <th scope="col">Length known</th>
            </tr>
          </thead>
          <tbody>
            {[...s.backlog.byKind, s.backlog.total].map((b) => (
              <tr key={b.kind} className={b.kind === 'all' ? 'total' : undefined}>
                <th scope="row">{b.kind === 'all' ? 'All' : kindLabel(b.kind)}</th>
                <td>{b.withLength ? hours(b.low, b.high) : 'unknown'}</td>
                <td>
                  {n(b.items)}
                  {b.inProgress > 0 && (
                    <span className="muted small"> ({n(b.inProgress)} started)</span>
                  )}
                </td>
                <td>
                  {n(b.withLength)} of {n(b.items)} ({pct(b.withLength, b.items)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section" aria-labelledby="cov-h">
        <h2 id="cov-h">What the app knows about your books</h2>
        <table className="table">
          <caption className="visually-hidden">Data coverage by kind</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Books</th>
              <th scope="col">Rated online</th>
              <th scope="col">Length known</th>
              <th scope="col">Series known</th>
            </tr>
          </thead>
          <tbody>
            {s.coverage.map((c) => (
              <tr key={c.kind}>
                <th scope="row">{kindLabel(c.kind)}</th>
                <td>{n(c.items)}</td>
                <td>{pct(c.rated, c.items)}</td>
                <td>{pct(c.lengthKnown, c.items)}</td>
                <td>{pct(c.seriesKnown, c.items)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small">
          Matches: {n(s.matches.byBand.accepted)} certain · {n(s.matches.byBand.provisional)}{' '}
          unconfirmed · {n(s.matches.byBand.tie)} tied · {n(s.matches.byBand.unidentified)} not
          found
          {s.matches.byBand.notLookedUp > 0 &&
            ` · ${n(s.matches.byBand.notLookedUp)} not looked up yet`}
          . Your answers: {n(s.matches.labelled.confirmed)} confirmed,{' '}
          {n(s.matches.labelled.rejected)} rejected.{' '}
          <a href={hrefFor({ view: 'review' })} onClick={onLinkClick({ view: 'review' })}>
            Needs review
          </a>
        </p>
      </section>

      <section className="section" aria-labelledby="taste-h">
        <h2 id="taste-h">What taste has learned</h2>
        {!s.taste.active ? (
          <p className="muted">
            Not on yet: it needs {s.taste.threshold} books you’ve rated, finished or stopped as “Not
            for me”, from at least {s.taste.minGroups} different authors or series. So far:{' '}
            {s.taste.outcomes} from {s.taste.groups}.
          </p>
        ) : s.taste.likes.length + s.taste.dislikes.length === 0 ? (
          <p className="muted">Nothing stands out from your average yet.</p>
        ) : (
          <ul>
            {[...s.taste.likes.slice(0, 5), ...s.taste.dislikes.slice(0, 3)].map((x) => (
              <li key={x.key}>
                {x.text} <span className="muted small">({x.evidence} books)</span>
              </li>
            ))}
          </ul>
        )}
        <p className="small">
          <a href={hrefFor({ view: 'tune' })} onClick={onLinkClick({ view: 'tune' })}>
            Tune
          </a>{' '}
          shows everything it has learned and lets you turn it down.
        </p>
      </section>

      <section className="section" aria-labelledby="take-h">
        <h2 id="take-h">Your takeaways</h2>
        {s.takeaways.length === 0 ? (
          <p className="muted">
            None yet. A book’s page has a Takeaway box for the one thing you want to remember.
          </p>
        ) : (
          <ul className="takeaways">
            {s.takeaways.map((t) => (
              <li key={t.id}>
                <a
                  href={hrefFor({ view: 'item', id: t.id })}
                  onClick={onLinkClick({ view: 'item', id: t.id })}
                >
                  {t.title}
                </a>
                {t.finishedOn && <span className="muted small"> · finished {t.finishedOn}</span>}
                <blockquote>{t.takeaway}</blockquote>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RateTable({
  caption,
  head,
  rows,
  kind = false,
}: {
  caption: string;
  head: string;
  rows: RateRow[];
  kind?: boolean;
}) {
  return (
    <table className="table">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{head}</th>
          <th scope="col">Finished</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row" className={kind ? undefined : 'folder-path'}>
              {kind ? kindLabel(r.label) : r.label}
            </th>
            <td>
              {n(r.finished)} of {n(r.owned)}
            </td>
            <td>{pct(r.finished, r.owned)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
