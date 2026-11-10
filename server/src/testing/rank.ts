import { rating } from './ratings.ts';
import type { RankItem, Situation } from '../lib/recommend.ts';

/** Builders for the pure ranking tests: invented items with only what each test needs. */

export const user = (over: Partial<RankItem['user']> = {}): RankItem['user'] => ({
  progress: 'not_started',
  dnfReason: null,
  startedOn: null,
  startedPrecision: null,
  finishedOn: null,
  finishedPrecision: null,
  progressAt: null,
  rating: null,
  note: null,
  takeaway: null,
  hidden: false,
  shortlistPosition: null,
  titleOverride: null,
  kindOverride: null,
  referenceOverride: null,
  icloudOverride: null,
  triage: null,
  effortOverride: null,
  preferredFileId: null,
  seriesOverride: null,
  seriesPositionOverride: null,
  stillReadingSnoozedUntil: null,
  relevanceDeferredAt: null,
  updatedAt: null,
  ...over,
});

let n = 0;
export const item = (
  over: Partial<Omit<RankItem, 'user'>> & { user?: Partial<RankItem['user']> } = {},
): RankItem => {
  const id = `r${++n}`;
  return {
    id,
    title: `Invented Book ${n}`,
    kind: 'fiction',
    isReference: false,
    creators: [{ name: `Author ${n}` }],
    coverFileId: null,
    formats: ['epub'],
    availability: { state: 'present', label: null, alsoInICloud: false, readyToRead: true },
    identity: 'accepted',
    matchConfirmed: false,
    historyOnly: false,
    series: null,
    duration: null,
    community: null,
    firstPublishYear: null,
    acquired: { date: null, basis: 'unknown' },
    effort: 'unknown',
    subjects: [],
    ...over,
    user: user(over.user),
  };
};

export const series = (
  key: string,
  position: number | null,
  over: Partial<NonNullable<RankItem['series']>> = {},
): NonNullable<RankItem['series']> => ({
  key,
  name: key,
  position,
  label: position === null ? null : String(position),
  unit: 'volume',
  status: 'unknown',
  total: null,
  ...over,
});

export const rated = (
  score: number,
  over: Partial<NonNullable<RankItem['community']>> = {},
): NonNullable<RankItem['community']> => ({
  ...rating(),
  match: 'accepted',
  tier: 1,
  reason: 'only_rating',
  label: null,
  hiddenGem:
    score >= 80 && !!over.fewVotes && over.scope !== 'series' && over.match !== 'provisional',
  fewElsewhere: false,
  raw: score / 20,
  scale: 5,
  votes: 500,
  scope: 'book',
  score,
  highlyRated: score >= 80,
  fewVotes: false,
  ...over,
});

export const measured = (minutes: number): NonNullable<RankItem['duration']> => ({
  low: Math.round(minutes * 0.8),
  high: Math.round(minutes * 1.2),
  measured: true,
  basis: 'from words',
  unit: 'book',
});

export const rough = (minutes: number): NonNullable<RankItem['duration']> => ({
  ...measured(minutes),
  measured: false,
  basis: 'assuming 275 words a page',
});

export const situation = (over: Partial<Situation> = {}): Situation => ({
  budget: null,
  mode: 'read_for',
  readyToRead: false,
  exclude: new Set(),
  today: '2026-11-10',
  recentDays: 60,
  ...over,
});

export const page = { offset: 0, limit: 50 };
