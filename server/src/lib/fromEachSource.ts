import { decisionsFor, type MatchRow } from '../identify/lookups.ts';
import { SOURCE_LABELS, type SourceName, type SourceRating } from '../sources/types.ts';
import { descriptionText, type ItemDetails } from './details.ts';
import type { RatingReason, RatingSelection } from './ratings.ts';

/**
 * "From each source" on the book page (plan stage 3). Pure: every source that was asked about a
 * book, what it said, and which of its values the app uses and why. Nothing here chooses a
 * value; it explains the choices stages 1 and 2 already made. Rejected candidates are other
 * books and are left out. Text from sources is returned as plain text (§6.3).
 */

export type SourceStatus =
  | 'confirmed'
  | 'accepted'
  | 'unconfirmed'
  | 'tie'
  | 'no_good_match'
  | 'not_found'
  | 'failed'
  | 'skipped'
  | 'not_looked_up'
  | 'not_used';

export type UsedField = 'rating' | 'title' | 'creators' | 'year' | 'pages' | 'description';

export interface SourceEntry {
  source: SourceName;
  label: string;
  status: SourceStatus;
  statusText: string;
  /** When the app last asked this source about the book (stage 4 adds the last real answer). */
  lookedUpAt: string | null;
  /** When the source last actually answered over the network (stage 4); null if unknown. */
  lastAnswerAt: string | null;
  record: {
    sourceId: string;
    title: string;
    subtitle: string | null;
    authors: string[];
    year: number | null;
    pages: number | null;
    description: string | null;
    subjects: string[];
    url: string | null;
  } | null;
  rating: Pick<SourceRating, 'value' | 'scale' | 'count' | 'scope'> | null;
  /** Why there is no rating, in plain words, when the source has a record but no rating. */
  ratingNote: string | null;
  used: { field: UsedField; reason: string }[];
  /**
   * The latest lookup's problem when an earlier answer is still shown (a failed lookup keeps the
   * match it had): the error matters, an expired key above all. Null when the status says it.
   */
  problem: string | null;
}

export interface FromEachSource {
  entries: SourceEntry[];
  /** Sources that weren't asked: this kind of book isn't theirs, or they aren't set up. */
  notAsked: { source: SourceName; label: string; why: 'kind' | 'not_set_up' }[];
}

export interface FromEachSourceInput {
  demo: boolean;
  /** Sources asked for this item now (`Sources.forItem`). */
  asked: SourceName[];
  /** Sources that would cover this kind of item if all were set up. */
  covering: SourceName[];
  configured: (s: SourceName) => boolean;
  lookups: {
    source: SourceName;
    outcome: string;
    looked_up_at: string;
    error: string | null;
    last_answer_at?: string | null;
  }[];
  matches: MatchRow[];
  rejected: Set<string>;
  override: string | null;
  rating: RatingSelection | null;
  details: ItemDetails | null;
}

/** The sources a person can set up or that the app asks; Calibre and the demo appear only when used. */
const ONLINE: SourceName[] = ['openlibrary', 'hardcover', 'anilist', 'metron', 'comicvine'];
export const SUBJECTS_PER_SOURCE = 12;

const RATING_REASONS: Record<RatingReason, string> = {
  more_ratings: 'More ratings for this book',
  only_rating: 'The only rating for this book',
  series_fallback: 'Whole series; this volume has few or no ratings of its own',
  unconfirmed_only: 'Only an unconfirmed match has a rating',
  sparse_rating: 'Few ratings, but the best available',
  match_tiebreak: 'Same number of ratings; the stronger match',
  supported_rating: 'Enough ratings for this book',
  item_scope: 'Rates this book, not the whole series',
  trusted_match: 'The only trusted match with a rating',
  no_rating: 'No rating',
};

const DETAIL_REASONS: Record<string, string> = {
  calibre_title: 'From your Calibre library',
  strongest_match: 'The strongest trusted match',
  calibre_creators: 'From your Calibre library',
  earliest_trusted_year: 'Earliest year from a trusted source',
  issue_cover_year: 'This issue’s cover year',
  file_isbn: 'Matches the ISBN in your file',
  useful_hardcover: 'Hardcover’s description is preferred',
  longest_description: 'The fullest description',
};

const STATUS_ORDER: SourceStatus[] = [
  'confirmed',
  'accepted',
  'unconfirmed',
  'tie',
  'no_good_match',
  'not_found',
  'failed',
  'skipped',
  'not_looked_up',
  'not_used',
];

function statusText(status: SourceStatus, label: string, error: string | null): string {
  switch (status) {
    case 'confirmed':
      return 'Matched — confirmed by you';
    case 'accepted':
      return label === SOURCE_LABELS.calibre ? 'From your Calibre library' : 'Matched';
    case 'unconfirmed':
      return 'Probably this book (unconfirmed)';
    case 'tie':
      return 'Two possible matches — choose one under Possible matches';
    case 'no_good_match':
      return `No close enough match on ${label}`;
    case 'not_found':
      return `Not found on ${label}`;
    case 'failed':
      return `${label} couldn’t be reached last time${error ? ` (${error})` : ''}; will retry`;
    case 'skipped':
      return label === SOURCE_LABELS.comicvine
        ? 'Not asked: Metron already answered for this issue'
        : 'Not asked this time';
    case 'not_looked_up':
      return 'Not looked up yet';
    case 'not_used':
      return 'Not used: you chose to leave this book unidentified';
  }
}

export function fromEachSource(input: FromEachSourceInput): FromEachSource {
  const live = input.matches.filter((m) => !input.rejected.has(`${m.source}:${m.sourceId}`));
  const decisions = decisionsFor(input.matches, input.rejected);
  const lookups = new Map(input.lookups.map((l) => [l.source, l]));
  const names = new Set<SourceName>([
    ...input.asked,
    ...live.map((m) => m.source),
    ...input.lookups.map((l) => l.source),
  ]);
  const confirmed = input.override?.includes(':') ? input.override : null;
  const chosenRating = input.rating?.chosen ?? null;
  const d = input.details;

  const entries: SourceEntry[] = [...names].map((source) => {
    const label = SOURCE_LABELS[source];
    const l = lookups.get(source);
    const decision = decisions.get(source);
    const mine = confirmed?.startsWith(`${source}:`)
      ? (live.find((m) => `${m.source}:${m.sourceId}` === confirmed) ?? null)
      : null;
    let status: SourceStatus;
    let row: MatchRow | null = null;
    if (input.override === 'none') {
      status = 'not_used';
      row = decision?.best ?? null;
    } else if (mine) {
      status = 'confirmed';
      row = mine;
    } else if (decision?.decision === 'accepted' || decision?.decision === 'provisional') {
      status = decision.decision === 'accepted' ? 'accepted' : 'unconfirmed';
      row = decision.best;
    } else if (decision?.decision === 'tie') status = 'tie';
    else if (decision) status = 'no_good_match';
    else if (!l) status = 'not_looked_up';
    else if (l.outcome === 'failed') status = 'failed';
    else if (l.outcome === 'skipped') status = 'skipped';
    else status = 'not_found';

    const r = row?.record ?? null;
    const used: SourceEntry['used'] = [];
    const sameRecord = (v: { source: string; sourceId: string | null } | null | undefined) =>
      !!r && !!v && v.source === source && v.sourceId === r.sourceId;
    if (chosenRating && r && chosenRating.source === source && chosenRating.sourceId === r.sourceId)
      used.push({ field: 'rating', reason: RATING_REASONS[chosenRating.reason] });
    if (d) {
      const fields: [UsedField, ItemDetails[keyof ItemDetails]][] = [
        ['title', d.title],
        ['creators', d.creators],
        ['year', d.firstPublishYear],
        ['pages', d.pages],
        ['description', d.description],
      ];
      for (const [field, v] of fields) {
        const dv = v as { source: string; sourceId: string | null; reason: string } | null;
        if (sameRecord(dv)) used.push({ field, reason: DETAIL_REASONS[dv!.reason] ?? dv!.reason });
      }
    }
    const description = r?.description ? descriptionText(r.description) : '';
    return {
      source,
      label,
      status,
      statusText: statusText(status, label, l?.error ?? null),
      lookedUpAt: l?.looked_up_at ?? null,
      lastAnswerAt: l?.last_answer_at ?? null,
      record: r
        ? {
            sourceId: r.sourceId,
            title: r.title,
            subtitle: r.subtitle ?? null,
            authors: r.authors,
            year: r.firstPublishYear ?? null,
            pages: r.pages ?? null,
            description: description || null,
            subjects: [...new Set(r.subjects)].slice(0, SUBJECTS_PER_SOURCE),
            url: r.url ?? null,
          }
        : null,
      rating: r?.rating
        ? {
            value: r.rating.value,
            scale: r.rating.scale,
            count: r.rating.count ?? null,
            scope: r.rating.scope,
          }
        : null,
      ratingNote: r && !r.rating ? `${label} has no rating for this book` : null,
      used,
      problem:
        status === 'failed' || !l?.error
          ? null
          : l.outcome === 'failed'
            ? `The last lookup failed (${l.error}); showing the earlier answer. It will be tried again.`
            : l.error,
    };
  });

  entries.sort(
    (a, b) =>
      Number(b.used.length > 0) - Number(a.used.length > 0) ||
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.label.localeCompare(b.label),
  );

  const notAsked: FromEachSource['notAsked'] = input.demo
    ? []
    : ONLINE.filter((s) => !names.has(s)).map((source) => ({
        source,
        label: SOURCE_LABELS[source],
        why: input.covering.includes(source) && !input.configured(source) ? 'not_set_up' : 'kind',
      }));
  return { entries, notAsked };
}
