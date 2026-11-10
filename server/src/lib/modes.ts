import {
  CLASSICS_AGE_YEARS,
  ONE_SITTING_MINUTES,
  STILL_READING_DAYS,
  SURPRISE_POOL,
} from '../config.ts';
import {
  buildCard,
  completeness,
  diversify,
  ineligibleBecause,
  onePerSeries,
  onePerWork,
  shows,
  topicsOf,
  type Card,
  type Mood,
  type RankItem,
  type Situation,
} from './recommend.ts';
import { SOURCE_LABELS } from '../sources/types.ts';

/**
 * The ten modes (PLAN.md §13.10). Pure. Every mode starts from the same pool — shared
 * eligibility (§13.1), one card per book, the filters, then one per series — and never loosens
 * it to fill the screen: an empty list says why instead.
 */

export const MODE_IDS = [
  'read_next',
  'continue',
  'next_in_series',
  'one_sitting',
  'waiting',
  'hidden_gems',
  'classics',
  'still_relevant',
  'mood',
  'surprise',
] as const;
export type ModeId = (typeof MODE_IDS)[number];

export interface ModeInfo {
  id: ModeId;
  label: string;
  /** The rule, in plain words (§13.10: "the description states the rule"). */
  description: string;
  /** Does the time control change this list? */
  usesTime: boolean;
}

export const MODES: ModeInfo[] = [
  {
    id: 'read_next',
    label: 'Read next',
    description: 'The best picks for the time you have, from ratings, length, taste and progress.',
    usesTime: true,
  },
  {
    id: 'continue',
    label: 'Continue reading',
    description:
      'Books you’ve started. Your shortlist first, in its order; then the ones you’re nearly done with, then halfway, into it and sampled — most recently touched first.',
    usesTime: false,
  },
  {
    id: 'next_in_series',
    label: 'Next in series',
    description:
      'The next book or issue you own in each series you’ve started. An earlier one you skipped comes first. Gaps are warned about, never blocked.',
    usesTime: false,
  },
  {
    id: 'one_sitting',
    label: 'One-sitting reads',
    description:
      'Whole books and single installments whose measured length fits in one sitting (2 hours unless you pick a time).',
    usesTime: true,
  },
  {
    id: 'waiting',
    label: 'Waiting on your shelf',
    description:
      'Highly rated books you haven’t started, the ones you’ve had longest first. Dates show where they came from.',
    usesTime: false,
  },
  {
    id: 'hidden_gems',
    label: 'Hidden gems',
    description:
      'Highly rated, but with few ratings for their source — the bottom quarter in your library, and at least 5. A book with no rating count isn’t treated as obscure.',
    usesTime: false,
  },
  {
    id: 'classics',
    label: 'Classics you missed',
    description: `Highly rated books you haven’t started, first published ${CLASSICS_AGE_YEARS} or more years ago.`,
    usesTime: false,
  },
  {
    id: 'still_relevant',
    label: 'Still relevant?',
    description:
      'A review of tech books you haven’t decided on. Version-specific titles first, then ones outside your topics, then oldest. The signals are context; you decide. Old fundamentals aren’t stale.',
    usesTime: false,
  },
  {
    id: 'mood',
    label: 'Mood',
    description:
      'Escape (fiction, comics, manga), Learn (nonfiction, tech, self-help) or Skim (short items and reference). Moves matching books up; doesn’t hide the rest.',
    usesTime: true,
  },
  {
    id: 'surprise',
    label: 'Surprise me',
    description:
      'A random pick from your top 50, favouring the top without always choosing it. Reroll for another.',
    usesTime: true,
  },
];

const IN_PROGRESS = ['sampled', 'into_it', 'halfway', 'nearly_done'];

export interface ModeResult {
  cards: Card[];
  mightFit: Card[];
  total: number;
  coverage: { eligible: number; rated: number; lengthKnown: number };
  /** Complete stories only: series left out, by the condition that failed (§13.3). */
  leftOut?: { ongoing: number; unknown: number; missing: number };
  /** Why an empty list is empty, in plain words. */
  empty?: string;
}

export interface ModeOptions {
  offset: number;
  limit: number;
  /** Surprise me: random number source (injectable for tests). */
  rng?: () => number;
  /** Surprise me: the last pick, so a reroll never repeats it immediately. */
  previous?: string[];
}

/**
 * The shared pool: eligible, one per book, the filters, one per series. Reference items only
 * where §13.1 allows them (Skim, a topic, Still relevant?).
 */
export function pool(
  all: RankItem[],
  s: Situation,
  opts: { reference?: boolean; series?: boolean } = {},
): { items: RankItem[]; twins: Set<string>; leftOut: ModeResult['leftOut'] } {
  const { kept, twins } = onePerWork(all.filter((i) => ineligibleBecause(i) === null));
  const reference = opts.reference || s.mood === 'skim' || !!s.topic;
  const filtered = kept.filter(
    (i) =>
      (reference || !i.isReference) &&
      !s.exclude.has(i.id) &&
      shows(i, s.show) &&
      (!s.readyToRead || i.availability.readyToRead) &&
      (!s.topic || topicsOf(i, [s.topic]).length > 0),
  );
  let items = opts.series === false ? filtered : onePerSeries(filtered, all);
  let leftOut: ModeResult['leftOut'];
  if (s.completeOnly) {
    leftOut = { ongoing: 0, unknown: 0, missing: 0 };
    const out: RankItem[] = [];
    for (const i of items) {
      const c = completeness(i, all);
      if (c.ok) out.push(i);
      else leftOut[c.why]++;
    }
    items = out;
  }
  return { items, twins, leftOut };
}

function cardsFor(items: RankItem[], all: RankItem[], s: Situation, twins: Set<string>): Card[] {
  return items.map((i) => {
    const c = buildCard(i, all, s);
    if (twins.has(i.id))
      c.limitations.push('also in your library under another name — see Needs review');
    return c;
  });
}

const coverageOf = (items: RankItem[]) => ({
  eligible: items.length,
  rated: items.filter((i) => i.community || i.user.rating !== null).length,
  lengthKnown: items.filter((i) => i.duration).length,
});

const byScore = (a: Card, b: Card) => b.score - a.score || a.title.localeCompare(b.title);

function paged(cards: Card[], o: ModeOptions): Card[] {
  return cards.slice(o.offset, o.offset + o.limit);
}

/** Read next, Mood and One-sitting reads: the blend, with "might fit" kept apart (§13.2). */
function blended(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, s);
  const cards = cardsFor(p.items, all, s, p.twins);
  let main = cards;
  let mightFit: Card[] = [];
  if (s.mode === 'finish_within' && s.budget !== null) {
    main = cards.filter((c) => c.fit === 'fits');
    mightFit = cards
      .filter((c) => c.fit === 'might_fit')
      .sort(byScore)
      .slice(0, o.limit);
  }
  main = diversify(main.sort(byScore));
  return {
    cards: paged(main, o),
    mightFit,
    total: main.length,
    coverage: coverageOf(p.items),
    leftOut: p.leftOut,
  };
}

const lastTouched = (i: RankItem) => i.user.progressAt ?? i.user.updatedAt ?? '';

/** Continue reading (§13.10): the owner's shortlist order beats the app's inference. */
function continueReading(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, { ...s, completeOnly: false });
  const going = p.items.filter((i) => IN_PROGRESS.includes(i.user.progress));
  const bucket = (i: RankItem) =>
    ['nearly_done', 'halfway', 'into_it', 'sampled'].indexOf(i.user.progress);
  going.sort((a, b) => {
    const sa = a.user.shortlistPosition ?? Infinity;
    const sb = b.user.shortlistPosition ?? Infinity;
    if (sa !== sb) return sa - sb;
    return (
      bucket(a) - bucket(b) ||
      lastTouched(b).localeCompare(lastTouched(a)) ||
      a.title.localeCompare(b.title)
    );
  });
  const cards = cardsFor(going, all, s, p.twins);
  for (const c of cards) if (c.shortlisted) c.reasons.unshift('On your shortlist');
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    empty: 'Nothing in progress. Mark a book Sampled or Into it and it shows up here.',
  };
}

/** Has the owner read or started anything in this series (read elsewhere counts)? */
function startedSeries(all: RankItem[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const i of all) {
    if (!i.series) continue;
    const p = i.user.progress;
    if (p !== 'finished' && !IN_PROGRESS.includes(p) && i.via !== 'collection') continue;
    const when = i.user.progressAt ?? i.user.finishedOn ?? '';
    const prev = latest.get(i.series.key);
    if (prev === undefined || when > prev) latest.set(i.series.key, when);
  }
  return latest;
}

/** Next in series (§13.10): the next eligible owned installment of each started series. */
function nextInSeries(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, s);
  const started = startedSeries(all);
  const next = p.items.filter(
    (i) => i.series && i.series.position !== null && started.has(i.series.key),
  );
  const cards = cardsFor(next, all, s, p.twins);
  const byId = new Map(next.map((i) => [i.id, i]));
  cards.sort((a, b) => {
    const ia = byId.get(a.id)!;
    const ib = byId.get(b.id)!;
    const ga = IN_PROGRESS.includes(ia.user.progress) ? 0 : 1;
    const gb = IN_PROGRESS.includes(ib.user.progress) ? 0 : 1;
    return (
      ga - gb ||
      started.get(ib.series!.key)!.localeCompare(started.get(ia.series!.key)!) ||
      byScore(a, b)
    );
  });
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    leftOut: p.leftOut,
    empty:
      started.size === 0
        ? 'You haven’t started a series yet. Once you finish or start a book in one, its next book shows up here.'
        : 'Nothing owned comes next in the series you’ve started.',
  };
}

function oneSitting(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const budget = s.budget ?? ONE_SITTING_MINUTES;
  const r = blended(all, { ...s, budget, mode: 'finish_within' }, o);
  return {
    ...r,
    empty: `Nothing has a measured length that fits in ${budget >= 60 ? `${budget / 60} hour${budget === 60 ? '' : 's'}` : `${budget} minutes`}.`,
  };
}

const BASIS_TEXT: Record<RankItem['acquired']['basis'], string> = {
  entered: 'the date you entered',
  file_date: 'from the file date',
  first_seen: 'first seen by a scan',
  unknown: '',
};

/** Waiting on your shelf (§13.10): highly rated, not started, waiting longest. */
function waiting(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, s);
  const items = p.items.filter(
    (i) => i.user.progress === 'not_started' && i.community?.highlyRated,
  );
  items.sort((a, b) => {
    const da = a.acquired.date ?? '9999';
    const db = b.acquired.date ?? '9999';
    return (
      da.localeCompare(db) ||
      (b.community?.score ?? 0) - (a.community?.score ?? 0) ||
      a.title.localeCompare(b.title)
    );
  });
  const cards = cardsFor(items, all, s, p.twins);
  cards.forEach((c, n) => {
    const a = items[n]!.acquired;
    if (a.date) c.reasons.unshift(`On your shelf since ${a.date} (${BASIS_TEXT[a.basis]})`);
    else c.limitations.unshift('when you got it is unknown');
  });
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    leftOut: p.leftOut,
    empty:
      'No highly rated books waiting. Ratings come from online lookups; a Hardcover token brings more.',
  };
}

function hiddenGems(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, s);
  const items = p.items.filter(
    (i) => i.community?.highlyRated && i.community.fewVotes && i.community.scope !== 'series',
  );
  const cards = cardsFor(items, all, s, p.twins).sort(byScore);
  cards.forEach((c) => {
    const r = items.find((i) => i.id === c.id)!.community!;
    c.reasons.splice(
      1,
      0,
      `Only ${r.votes} ratings on ${SOURCE_LABELS[r.source]} — few for your library`,
    );
  });
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    leftOut: p.leftOut,
    empty: 'No hidden gems found: none of your highly rated books has few ratings.',
  };
}

function classics(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(all, s);
  const year = Number(s.today.slice(0, 4));
  const items = p.items.filter(
    (i) =>
      // Never started: not even a start date left from an earlier attempt (scenario 16).
      i.user.progress === 'not_started' &&
      !i.user.startedOn &&
      i.community?.highlyRated &&
      i.firstPublishYear !== null &&
      i.firstPublishYear <= year - CLASSICS_AGE_YEARS,
  );
  const cards = cardsFor(items, all, s, p.twins).sort(byScore);
  cards.forEach((c) =>
    c.reasons.push(`First published in ${items.find((i) => i.id === c.id)!.firstPublishYear}`),
  );
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    leftOut: p.leftOut,
    empty: `No highly rated unstarted books with a known first publication ${CLASSICS_AGE_YEARS}+ years ago.`,
  };
}

// ---- Still relevant? (§13.10) -----------------------------------------------------------------

/**
 * Technologies whose books are tied to a version. A title naming one with a number ("React 16",
 * "Python 2", "Visual Studio 2010", "HTML5") is version-specific.
 */
const TECH_NAMES = [
  'react',
  'angular',
  'angularjs',
  'vue',
  'python',
  'java',
  'javascript',
  'ecmascript',
  'es',
  'typescript',
  'c#',
  'f#',
  '.net',
  'asp.net',
  'php',
  'ruby',
  'rails',
  'django',
  'flask',
  'node',
  'node.js',
  'swift',
  'ios',
  'android',
  'windows',
  'windows server',
  'excel',
  'office',
  'word',
  'access',
  'html',
  'css',
  'kotlin',
  'scala',
  'spring',
  'spring boot',
  'hibernate',
  'unity',
  'unreal engine',
  'sql server',
  'oracle',
  'mysql',
  'postgresql',
  'perl',
  'laravel',
  'symfony',
  'wordpress',
  'drupal',
  'jquery',
  'bootstrap',
  'xcode',
  'visual studio',
  'kubernetes',
  'docker',
  'tensorflow',
  'pandas',
  'spark',
  'hadoop',
  'ubuntu',
  'red hat',
  'rhel',
  'centos',
  'debian',
  'macos',
  'os x',
  'mac os x',
  'linux',
  'photoshop',
  'illustrator',
  'blender',
  'godot',
  'qt',
  'gtk',
  'vb',
  'vba',
  'visual basic',
  'silverlight',
  'flash',
  'actionscript',
  'cocoa',
  'objective-c',
  'cobol',
  'fortran',
  'c++',
  'go',
  'rust',
  'elixir',
  'haskell',
  'ansible',
  'terraform',
  'aws',
  'azure',
  'sharepoint',
  'exchange',
  'active directory',
  'powershell',
  'raspberry pi',
  'arduino',
  'opengl',
  'directx',
  'webgl',
  'ccna',
  'ccnp',
  'comptia',
];
// No '#': escaping it is a syntax error in a Unicode-mode expression.
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(${[...TECH_NAMES]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})([ -]?v?)((?:19|20)\\d\\d|\\d{1,2}(?:\\.\\d{1,2}){0,2})(?![\\p{L}\\p{N}])`,
  'iu',
);

/**
 * Names that are also ordinary words ("Word 2", "Go 2", "Unity 3"): a version only in the year
 * form ("Office 2016") or written together ("ES6").
 */
const AMBIGUOUS = new Set([
  'word',
  'access',
  'go',
  'office',
  'exchange',
  'flash',
  'es',
  'spring',
  'unity',
]);

/** "React 16", "Python 3.12", "HTML5": the technology and version a title names, if any. */
export function versionIn(title: string): string | null {
  const m = VERSION_RE.exec(title.replace(/_/g, ' '));
  if (!m) return null;
  const [, name, sep, v] = m as unknown as [string, string, string, string];
  const year = /^(19|20)\d\d$/.test(v);
  if (AMBIGUOUS.has(name.toLowerCase()) && !year && sep !== '') return null;
  return `${name} ${v}`;
}

export interface RelevanceCard extends Card {
  signals: string[];
  deferred: boolean;
}

function stillRelevant(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const p = pool(
    all,
    { ...s, show: 'all', completeOnly: false, topic: null },
    { reference: true, series: false },
  );
  const topics = s.topics ?? [];
  const year = Number(s.today.slice(0, 4));
  const items = p.items.filter(
    (i) =>
      i.kind === 'tech' &&
      i.user.progress === 'not_started' &&
      i.user.triage !== 'want' &&
      i.user.triage !== 'never' &&
      i.user.referenceOverride === null,
  );
  const info = new Map(
    items.map((i) => {
      const version = versionIn(i.title);
      const about = topicsOf(i, topics);
      return [i.id, { version, about, outside: topics.length > 0 && about.length === 0 }];
    }),
  );
  items.sort((a, b) => {
    const ia = info.get(a.id)!;
    const ib = info.get(b.id)!;
    const da = a.user.relevanceDeferredAt ? 1 : 0;
    const db = b.user.relevanceDeferredAt ? 1 : 0;
    return (
      da - db ||
      Number(!!ib.version) - Number(!!ia.version) ||
      Number(ib.outside) - Number(ia.outside) ||
      (a.firstPublishYear ?? 9999) - (b.firstPublishYear ?? 9999) ||
      a.title.localeCompare(b.title)
    );
  });
  const cards: RelevanceCard[] = cardsFor(items, all, s, p.twins).map((c, n) => {
    const i = items[n]!;
    const x = info.get(i.id)!;
    const signals: string[] = [];
    if (x.version) signals.push(`Names a version: ${x.version}`);
    if (i.firstPublishYear !== null) {
      const age = year - i.firstPublishYear;
      signals.push(
        `Published ${i.firstPublishYear}${age > 0 ? ` (${age} year${age === 1 ? '' : 's'} ago)` : ''}`,
      );
    } else signals.push('Publication year unknown');
    if (topics.length > 0)
      signals.push(
        x.about.length > 0
          ? `About ${x.about.join(', ')}, one of your topics`
          : 'Not about any of your topics',
      );
    if (i.isReference) signals.push('Looks like a reference book');
    return { ...c, signals, deferred: !!i.user.relevanceDeferredAt };
  });
  return {
    cards: paged(cards, o),
    mightFit: [],
    total: cards.length,
    coverage: coverageOf(p.items),
    empty: 'No tech books left to review. Ones you mark Want, Never or reference leave this list.',
  };
}

// ---- Surprise me (§13.10) ---------------------------------------------------------------------

/** A weighted random pick from the top of Read next: probability ∝ score² (§20). */
export function surprise(all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  const r = blended(all, s, { offset: 0, limit: SURPRISE_POOL });
  const prev = new Set(o.previous ?? []);
  let top = r.cards.filter((c) => !prev.has(c.id));
  // With only the previous pick left, showing it again beats showing nothing.
  if (top.length === 0) top = r.cards;
  const weights = top.map((c) => Math.max(c.score, 0) ** 2);
  const sum = weights.reduce((a, w) => a + w, 0);
  const rng = o.rng ?? Math.random;
  let x = rng() * sum;
  let pick = top[top.length - 1];
  for (let n = 0; n < top.length; n++) {
    x -= weights[n]!;
    if (x < 0) {
      pick = top[n];
      break;
    }
  }
  return {
    cards: pick ? [pick] : [],
    mightFit: [],
    total: Math.min(r.total, SURPRISE_POOL),
    coverage: r.coverage,
    leftOut: r.leftOut,
    empty: 'Nothing to pick from with these settings.',
  };
}

export function runMode(mode: ModeId, all: RankItem[], s: Situation, o: ModeOptions): ModeResult {
  switch (mode) {
    case 'continue':
      return continueReading(all, s, o);
    case 'next_in_series':
      return nextInSeries(all, s, o);
    case 'one_sitting':
      return oneSitting(all, s, o);
    case 'waiting':
      return waiting(all, s, o);
    case 'hidden_gems':
      return hiddenGems(all, s, o);
    case 'classics':
      return classics(all, s, o);
    case 'still_relevant':
      return stillRelevant(all, s, o);
    case 'surprise':
      return surprise(all, s, o);
    case 'mood':
      return blended(all, { ...s, mood: s.mood ?? 'escape' }, o);
    default:
      return blended(all, { ...s, mood: null }, o);
  }
}

export const MOODS: { id: Mood; label: string; description: string }[] = [
  { id: 'escape', label: 'Escape', description: 'Fiction, comics and manga' },
  { id: 'learn', label: 'Learn', description: 'Nonfiction, tech and self-help' },
  { id: 'skim', label: 'Skim', description: 'Short items and reference' },
];

// ---- Still reading? (§13.6) -------------------------------------------------------------------

/**
 * In progress and untouched for STILL_READING_DAYS, unless snoozed: gathered into one digest,
 * never a stream of prompts. A book with no record of when it was last touched isn't guessed at.
 */
export function stillReadingDue(all: RankItem[], today: string): RankItem[] {
  const cutoff = Date.parse(today) - STILL_READING_DAYS * 86_400_000;
  return all
    .filter(
      (i) =>
        !i.historyOnly &&
        IN_PROGRESS.includes(i.user.progress) &&
        i.user.progressAt !== null &&
        Date.parse(i.user.progressAt) < cutoff &&
        !(i.user.stillReadingSnoozedUntil && i.user.stillReadingSnoozedUntil > today),
    )
    .sort((a, b) => a.user.progressAt!.localeCompare(b.user.progressAt!));
}

/** Read next (§13.10): the blend with the time control. */
export function readNext(all: RankItem[], s: Situation, page: { offset: number; limit: number }) {
  return runMode('read_next', all, s, page);
}
