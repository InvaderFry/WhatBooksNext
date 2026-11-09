import { MATCH_ACCEPT, MATCH_REVIEW, MATCH_TIE_MARGIN } from '../config.ts';
import type { SourceQuery, SourceRecord } from '../sources/types.ts';
import { normalizeForCompare, titleCompareKey } from './filename.ts';

/**
 * Matching and confidence (PLAN.md §11.2). Evidence, strongest first: corroborated identifiers
 * → embedded metadata → filename → folder hints. The score is a heuristic for sorting, not a
 * probability. Pure: no database, no network.
 *
 * Calibration (fixture set, `npm run report:matches`): an exact title with an agreeing author
 * scores 1.0 (accepted); an exact title with no author to check scores 0.85 (provisional,
 * shown "unconfirmed"); a disagreeing author drops even an exact title below 0.6. That keeps
 * filename-only guesses out of "accepted" — cautious, because a wrong match hurts more than
 * none (§4).
 */

/** Bump when the scoring changes: the next lookup re-scores from the cache (no new requests). */
export const MATCH_VERSION = 5;

export interface MatchFacts {
  title: string;
  /** Where the title came from: the file's own metadata is stronger than its name. */
  titleSource: 'embedded' | 'filename';
  /** Run-together raw name, kept beside the split guess (§11.1). */
  rawTitle?: string;
  authors: string[];
  seriesHint?: string | null;
  volume?: string | null;
  issue?: string | null;
  /** Identifiers from an EPUB: strong evidence. */
  isbns: string[];
  /** ISBNs found inside a PDF: candidates only, never accepted alone (§10). */
  isbnCandidates: string[];
  kind: string | null;
}

export interface MatchEvidence {
  title: number;
  author: 'agrees' | 'conflicts' | 'unknown';
  isbn: 'strong' | 'candidate' | 'none';
  notes: string[];
}

export interface ScoredCandidate {
  record: SourceRecord;
  score: number;
  evidence: MatchEvidence;
}

export type Decision = 'accepted' | 'provisional' | 'tie' | 'unidentified';

const EDITION_SUFFIX = /\s*\((\d+)(st|nd|rd|th) edition\)\s*$/i;

/** The title to search and compare: without our "(2nd edition)" suffix or a "Vol. 1" label. */
export function searchTitle(f: MatchFacts): string {
  let t = f.title.replace(EDITION_SUFFIX, '');
  if (f.seriesHint && (f.volume || f.issue) && (f.kind === 'manga' || f.kind === 'comic'))
    t = f.seriesHint;
  return t.trim();
}

export function buildQuery(f: MatchFacts): SourceQuery {
  const q: SourceQuery = { title: searchTitle(f) };
  // Book sources list each volume of a comic or manga as its own book ("Series, Vol. 24"), so
  // the volume goes into their search. AniList searches by series name (q.series).
  const n = ourNumber(f);
  if (n && f.seriesHint && (f.kind === 'manga' || f.kind === 'comic'))
    q.title = `${f.seriesHint} ${n}`;
  // A "Title: Subtitle" from a filename searches better on the main title.
  if (f.titleSource === 'filename' && q.title.includes(':'))
    q.title = q.title.split(':')[0]!.trim();
  if (f.authors[0]) q.author = f.authors[0];
  if (f.isbns[0]) q.isbn = f.isbns[0];
  if (f.rawTitle && normalizeForCompare(f.rawTitle) !== normalizeForCompare(q.title))
    q.rawTitle = f.rawTitle;
  if (f.seriesHint) q.series = f.seriesHint;
  if (f.volume) q.volume = f.volume;
  return q;
}

/** Sørensen–Dice similarity of character bigrams: forgiving of small spelling differences. */
export function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/**
 * Volume numbers (§11.2). "Series 24", "Series, Vol. 24", "Series #24" and "Series Book 24" all
 * name volume 24. Two different numbers are two different books, however alike the titles.
 */
const NUMBER_MARK = /(?:^|[\s,:(])(?:vol(?:ume)?\.?|book|no\.?|#)\s*(\d+(?:\.\d+)?)\b/i;
const TRAILING_NUMBER = /\s(\d{1,3}(?:\.\d+)?)\s*$/;

export function numberIn(title: string): string | null {
  const m = NUMBER_MARK.exec(title) ?? TRAILING_NUMBER.exec(title);
  return m ? String(parseFloat(m[1]!)) : null;
}

function ourNumber(f: MatchFacts): string | null {
  const v = f.volume ?? f.issue;
  if (v && /^\d+(\.\d+)?$/.test(v)) return String(parseFloat(v));
  return numberIn(f.title.replace(EDITION_SUFFIX, ''));
}

/** The title without its volume marker and number, for comparing the series part. */
function withoutNumber(t: string): string {
  return t
    .replace(/[\s,:(]*(?:vol(?:ume)?\.?|book|no\.?|#)\s*\d+(?:\.\d+)?\)?/gi, ' ')
    .replace(TRAILING_NUMBER, ' ')
    .trim();
}

/**
 * A title that matches only once a subtitle is dropped, on either side ("Title" against
 * "Title: Subtitle"), scores at most this. It may be the same book with its subtitle, or another
 * book in a series that shares the main title — so on its own it can only ever be "unconfirmed".
 */
const MAIN_TITLE_ONLY = 0.85;

/**
 * A comic volume against a record with no number that doesn't say it's a comic: at most this,
 * which keeps it below "provisional" even with no author to check (0.85 × 0.7 < 0.6).
 */
const NAME_ONLY_NOT_COMIC = 0.7;

const isVisual = (f: MatchFacts) => f.kind === 'comic' || f.kind === 'manga';

/** Does the source say this record is a comic, graphic novel or manga? */
export function comicLike(r: SourceRecord): boolean {
  return (
    r.format === 'MANGA' ||
    r.source === 'anilist' ||
    r.subjects.some((x) => /comic|graphic novel|manga|superhero|cartoons? and comics/i.test(x))
  );
}

function titleScore(f: MatchFacts, r: SourceRecord): number {
  const mainOf = (t: string) => t.split(/[:—–]| - /)[0]!;
  const mine = [searchTitle(f), f.rawTitle ?? ''].filter(Boolean);
  const theirs = [r.title, ...(r.alternativeTitles ?? [])];
  const mineFull = new Set(mine.map(titleCompareKey).filter(Boolean));
  const theirFull = new Set(
    theirs
      .flatMap((t) => [
        titleCompareKey(t),
        ...(r.subtitle ? [titleCompareKey(`${t} ${r.subtitle}`)] : []),
      ])
      .filter(Boolean),
  );
  // Numbered volumes: compare the series part, also before a story-arc subtitle ("Series
  // Vol. 2: Arc Name"); scoreCandidate checks the numbers themselves.
  const series = (t: string) => [withoutNumber(t), withoutNumber(mainOf(t))];
  const mine0 = new Set(mine.flatMap(series).map(titleCompareKey).filter(Boolean));
  const their0 = new Set(theirs.flatMap(series).map(titleCompareKey).filter(Boolean));
  const a = ourNumber(f);
  const b = numberIn(fullTitleOf(r));
  if ((a || b) && [...mine0].some((k) => their0.has(k))) {
    if (a && b) return 1;
    // A volume against a record with no number is only the series' name: never certain,
    // except on AniList, whose records are whole series by design (scope "series"). For a comic
    // or manga, a record that doesn't say it's a comic is most likely a prose book that shares
    // the name (a novel called "Arrowsmith" against the comic "Arrowsmith Vol. 1").
    if (a && !b) {
      if (r.source === 'anilist') return 1;
      if (isVisual(f) && !comicLike(r)) return NAME_ONLY_NOT_COMIC;
      return MAIN_TITLE_ONLY;
    }
    if (!a && b) return MAIN_TITLE_ONLY;
  }
  let best = 0;
  for (const a of mineFull)
    for (const b of theirFull) best = Math.max(best, a === b ? 1 : similarity(a, b));
  if (best === 1) return 1;
  const mineMain = new Set(mine.map((t) => titleCompareKey(mainOf(t))).filter(Boolean));
  const theirMain = new Set(theirs.map((t) => titleCompareKey(mainOf(t))).filter(Boolean));
  const mainHit =
    [...mineMain].some((k) => theirFull.has(k) || theirMain.has(k)) ||
    [...theirMain].some((k) => mineFull.has(k));
  return mainHit ? Math.max(best, MAIN_TITLE_ONLY) : best;
}

/** Surname-level comparison: "H. G. Wells" agrees with "Wells, H.G." and "Herbert George Wells". */
function nameTokens(name: string): Set<string> {
  const parts = name.includes(',') ? name.split(',').reverse().join(' ') : name;
  return new Set(
    parts
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 3),
  );
}

function authorsAgree(mine: string[], theirs: string[]): 'agrees' | 'conflicts' | 'unknown' {
  if (mine.length === 0 || theirs.length === 0) return 'unknown';
  const theirTokens = theirs.map(nameTokens);
  for (const m of mine) {
    const t = nameTokens(m);
    if (t.size === 0) continue;
    if (theirTokens.some((x) => [...t].some((w) => x.has(w)))) return 'agrees';
  }
  return 'conflicts';
}

const isbnNorm = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase();

export function scoreCandidate(f: MatchFacts, r: SourceRecord): ScoredCandidate {
  const notes: string[] = [];
  const title = titleScore(f, r);
  const author = authorsAgree(f.authors, r.authors);
  const theirIsbns = new Set(r.isbns.map(isbnNorm));
  const isbn: MatchEvidence['isbn'] = f.isbns.some((i) => theirIsbns.has(isbnNorm(i)))
    ? 'strong'
    : f.isbnCandidates.some((i) => theirIsbns.has(isbnNorm(i)))
      ? 'candidate'
      : 'none';

  let score: number;
  // An agreeing author only counts with a close title: the same author's other books are
  // exactly what a title + author search returns, and they must never look like a match.
  if (title < 0.75) score = 0.6 * title;
  else if (author === 'agrees') score = 0.75 * title + 0.25;
  else if (author === 'conflicts') score = 0.5 * title;
  else score = 0.85 * title;

  const ours = ourNumber(f);
  const theirs = numberIn(fullTitleOf(r));
  if (ours && theirs && ours !== theirs && title >= 0.75) {
    score = Math.min(score, 0.3);
    notes.push(`Volume ${theirs}, not ${ours}.`);
  }

  if (isbn === 'strong') {
    // An EPUB's own ISBN is strong evidence, but only with a title that isn't plainly different.
    score = title >= 0.5 ? Math.max(score, 0.97) : Math.max(score, 0.7);
    notes.push('The file’s own ISBN matches.');
  } else if (isbn === 'candidate' && title >= 0.8 && author !== 'conflicts') {
    // A PDF's ISBN may be another book's (tech books cite others), so it only corroborates.
    score = Math.min(1, score + 0.1);
    notes.push('An ISBN printed in the PDF matches.');
  }
  if (title === 1) notes.push('Title matches.');
  else if (title >= 0.8) notes.push('Title is close.');
  else notes.push('Title differs.');
  if (author === 'agrees') notes.push('Author matches.');
  if (author === 'conflicts') notes.push('Author differs.');
  if (author === 'unknown' && f.authors.length === 0) notes.push('No author to check against.');
  return { record: r, score: round(score), evidence: { title: round(title), author, isbn, notes } };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Two records with the same title and an author in common are one work entered twice at the
 * source (Open Library and Hardcover both have such duplicates). Choosing between them can't
 * attach the wrong book, so they aren't a tie: the better-documented record wins.
 *
 * "The same title" also covers one record carrying the subtitle and the other not
 * ("Title: Subtitle" and "Title"). Two different subtitles stay different works
 * ("Title: Volume 1" and "Title: Volume 2").
 */
export function sameWork(a: SourceRecord, b: SourceRecord): boolean {
  const full = (r: SourceRecord) => titleCompareKey(fullTitle(r));
  const main = (r: SourceRecord) => titleCompareKey(fullTitle(r).split(/[:—–]| - /)[0]!);
  const fa = full(a);
  const fb = full(b);
  const sameTitle =
    fa === fb || (main(a) === main(b) && (fa === main(a) || fb === main(b))) || sameVolume(a, b);
  if (!sameTitle) return false;
  const surnames = (r: SourceRecord) =>
    new Set(
      r.authors.map((n) =>
        normalizeForCompare(
          n
            .split(/[\s,]+/)
            .filter(Boolean)
            .at(-1) ?? '',
        ),
      ),
    );
  const sa = surnames(a);
  if ([...surnames(b)].some((x) => x !== '' && sa.has(x))) return true;
  // One volume entered twice ("Series Vol. 2: Arc" and "Series - 2"), one record with no author.
  if (sameVolume(a, b) && (a.authors.length === 0 || b.authors.length === 0)) return true;
  // The same full title, and one record has no author at all: one book entered twice.
  return fa === fb && (a.authors.length === 0 || b.authors.length === 0);
}

/** The same series and the same volume number ("Series, Vol. 2: Arc" and "Series - 2"). */
function sameVolume(a: SourceRecord, b: SourceRecord): boolean {
  const na = numberIn(fullTitleOf(a));
  if (!na || na !== numberIn(fullTitleOf(b))) return false;
  const seriesKey = (r: SourceRecord) =>
    titleCompareKey(withoutNumber(fullTitleOf(r).split(/[:—–]| - (?!\d)/)[0]!));
  return seriesKey(a) !== '' && seriesKey(a) === seriesKey(b);
}

/** The title with its subtitle, unless the title already includes it. */
export function fullTitleOf(r: SourceRecord): string {
  return fullTitle(r);
}

function fullTitle(r: SourceRecord): string {
  if (!r.subtitle) return r.title;
  return normalizeForCompare(r.title).includes(normalizeForCompare(r.subtitle))
    ? r.title
    : `${r.title}: ${r.subtitle}`;
}

const weight = (r: SourceRecord) => (r.rating?.count ?? 0) + r.isbns.length;

/**
 * Picks the best candidate from one source's results (§11.2): ≥ 0.90 accepted, 0.60–0.90
 * provisional, below that unidentified. If the top two score within 0.05 of each other and
 * aren't the same work, neither is accepted: it's a tie for the owner to settle.
 */
export function decide(
  f: MatchFacts,
  records: SourceRecord[],
  rejected: Set<string> = new Set(),
): { decision: Decision; best: ScoredCandidate | null; ranked: ScoredCandidate[] } {
  const ranked = rankCandidates(
    records
      .filter((r) => !rejected.has(`${r.source}:${r.sourceId}`))
      .map((r) => scoreCandidate(f, r)),
  );
  return { ...decideRanked(ranked), ranked };
}

export function rankCandidates(c: ScoredCandidate[]): ScoredCandidate[] {
  return [...c].sort((a, b) => b.score - a.score || weight(b.record) - weight(a.record));
}

/** The decision for candidates already scored and ranked best first. */
export function decideRanked(ranked: ScoredCandidate[]): {
  decision: Decision;
  best: ScoredCandidate | null;
} {
  const [top, second] = ranked;
  if (!top || top.score < MATCH_REVIEW) return { decision: 'unidentified', best: null };
  if (second && top.score - second.score < MATCH_TIE_MARGIN && !sameWork(top.record, second.record))
    return { decision: 'tie', best: null };
  return { decision: top.score >= MATCH_ACCEPT ? 'accepted' : 'provisional', best: top };
}
