import {
  TASTE_EVIDENCE,
  TASTE_MIN_GROUPS,
  TASTE_MIN_SIGNAL,
  TASTE_PRIOR_WEIGHT,
  TASTE_REASON_MIN,
  TASTE_SERIES_CAP,
  TASTE_STRENGTH,
  TASTE_THRESHOLD,
} from '../config.ts';

/**
 * Taste learning (PLAN.md §13.11). Pure.
 *
 * - Learns from genres and tags, authors, comic writers and artists, publishers and kinds that
 *   stand out from the owner's own average.
 * - Evidence: your rating > finished (engagement, not necessarily enjoyment) > imported history.
 *   Only "Did not finish — Not for me" is negative.
 * - A series contributes at most TASTE_SERIES_CAP items of evidence.
 * - Inert below TASTE_THRESHOLD outcomes from TASTE_MIN_GROUPS authors or series: it changes
 *   nothing until then.
 */

export type TasteStrength = keyof typeof TASTE_STRENGTH;

export interface TasteInput {
  id: string;
  kind: string | null;
  creators: { name: string; role?: string }[];
  subjects?: string[];
  publisher?: string | null;
  seriesKey: string | null;
  historyOnly: boolean;
  progress: string;
  dnfReason: string | null;
  rating: number | null;
}

export interface Signal {
  key: string;
  /** "fantasy", "Ann Leckie". */
  label: string;
  type: 'genre' | 'author' | 'artist' | 'publisher' | 'kind';
  /** How far it stands out from the owner's average, about −1 to 1. */
  affinity: number;
  /** Evidence behind it, in books (after the series cap). */
  evidence: number;
  /** Mostly from the owner's ratings, rather than from finishing. */
  rated: boolean;
  /** Mostly from books stopped as "Not for me": only then may a sentence say so. */
  stopped: boolean;
}

export interface TasteModel {
  active: boolean;
  /** Outcomes after the series cap, and how many different authors or series they came from. */
  outcomes: number;
  groups: number;
  strength: TasteStrength;
  signals: Map<string, Signal>;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Words sources attach to almost everything, or that describe the edition rather than the work:
 * they'd only learn "the owner reads books".
 */
const NOISE = new Set([
  'fiction',
  'nonfiction',
  'non fiction',
  'general',
  'book',
  'books',
  'literature',
  'novel',
  'novels',
  'comics',
  'comic',
  'manga',
  'graphic novels',
  'large type books',
  'accessible book',
  'protected daisy',
  'in library',
  'lending library',
  'open library staff picks',
  'new york times bestseller',
  'new york times reviewed',
  'english language',
  'ebook',
  'ebooks',
  'electronic books',
  'popular print disabled books',
  'long now manual for civilization',
  'translations into english',
  'american',
  'english',
  'adult',
  'juvenile works',
]);

/** Genres and tags as separate words: "Fiction, fantasy, epic" → fantasy, epic. */
export function genresOf(subjects: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const s of (subjects ?? []).slice(0, 40)) {
    for (const part of s.split(/\s*(?:,|\/|--|>|;|\|)\s*/)) {
      const n = norm(part);
      if (n.length < 3 || n.length > 40 || NOISE.has(n) || /^\d/.test(n)) continue;
      if (/^(reading level|grade|nyt|award|accelerated reader)/.test(n)) continue;
      out.add(n);
    }
  }
  return [...out].slice(0, 15);
}

const ARTIST_ROLES = /pencil|artist|illustrat|ink|colou?r|letter|cover|art/i;

/** The signals an item carries: key → readable label and type. */
export function featuresOf(
  i: Pick<TasteInput, 'kind' | 'creators' | 'subjects' | 'publisher'>,
): Map<string, Pick<Signal, 'label' | 'type'>> {
  const f = new Map<string, Pick<Signal, 'label' | 'type'>>();
  if (i.kind) f.set(`kind:${i.kind}`, { label: KIND_LABELS[i.kind] ?? i.kind, type: 'kind' });
  for (const g of genresOf(i.subjects)) f.set(`genre:${g}`, { label: g, type: 'genre' });
  for (const c of i.creators.slice(0, 6)) {
    const n = norm(c.name);
    if (!n) continue;
    const artist = c.role && ARTIST_ROLES.test(c.role) && !/writ|author|story/i.test(c.role);
    if (artist) f.set(`artist:${n}`, { label: c.name, type: 'artist' });
    else f.set(`author:${n}`, { label: c.name, type: 'author' });
  }
  if (i.publisher) {
    const n = norm(i.publisher);
    if (n && n !== 'unknown') f.set(`publisher:${n}`, { label: i.publisher, type: 'publisher' });
  }
  return f;
}

const KIND_LABELS: Record<string, string> = {
  fiction: 'fiction',
  nonfiction: 'nonfiction',
  self_help: 'self-help',
  tech: 'tech books',
  comic: 'comics',
  manga: 'manga',
};

interface Evidence {
  item: TasteInput;
  value: number;
  weight: number;
  rated: boolean;
  stopped?: boolean;
}

/** What one item teaches, or null when it teaches nothing (§13.11). */
export function evidenceOf(i: TasteInput): Omit<Evidence, 'item'> | null {
  const imported = i.historyOnly ? TASTE_EVIDENCE.importedFactor : 1;
  if (i.rating !== null)
    return { value: (i.rating - 5.5) / 4.5, weight: TASTE_EVIDENCE.rated * imported, rated: true };
  if (i.progress === 'finished')
    return { value: 0.5, weight: TASTE_EVIDENCE.finished * imported, rated: false };
  if (i.progress === 'dnf' && i.dnfReason === 'not_for_me')
    return {
      value: -1,
      weight: TASTE_EVIDENCE.notForMe * imported,
      rated: false,
      stopped: true,
    };
  // DNF "Not now" and "Too difficult right now" teach nothing about dislike (§13.6).
  return null;
}

const firstAuthor = (i: TasteInput) => {
  const c = i.creators.find((x) => !x.role || !ARTIST_ROLES.test(x.role)) ?? i.creators[0];
  return c ? norm(c.name) : null;
};

export function learnTaste(items: TasteInput[], strength: TasteStrength = 'normal'): TasteModel {
  const ev: Evidence[] = [];
  for (const item of items) {
    const e = evidenceOf(item);
    if (e) ev.push({ item, ...e });
  }
  // The series cap: n outcomes in one series count as at most CAP, shared between them.
  const perSeries = new Map<string, number>();
  for (const e of ev)
    if (e.item.seriesKey)
      perSeries.set(e.item.seriesKey, (perSeries.get(e.item.seriesKey) ?? 0) + 1);
  for (const e of ev) {
    const n = e.item.seriesKey ? perSeries.get(e.item.seriesKey)! : 1;
    if (n > TASTE_SERIES_CAP) e.weight *= TASTE_SERIES_CAP / n;
  }
  let outcomes = ev.filter((e) => !e.item.seriesKey).length;
  for (const n of perSeries.values()) outcomes += Math.min(n, TASTE_SERIES_CAP);
  const groups = new Set(
    ev.map((e) =>
      e.item.seriesKey
        ? `s:${e.item.seriesKey}`
        : firstAuthor(e.item)
          ? `a:${firstAuthor(e.item)}`
          : `i:${e.item.id}`,
    ),
  ).size;
  const active = outcomes >= TASTE_THRESHOLD && groups >= TASTE_MIN_GROUPS;

  const totalW = ev.reduce((a, e) => a + e.weight, 0);
  const mean = totalW > 0 ? ev.reduce((a, e) => a + e.weight * e.value, 0) / totalW : 0;
  const acc = new Map<
    string,
    {
      label: string;
      type: Signal['type'];
      w: number;
      wv: number;
      ratedW: number;
      stoppedW: number;
    }
  >();
  for (const e of ev) {
    for (const [key, f] of featuresOf(e.item)) {
      const a = acc.get(key) ?? { ...f, w: 0, wv: 0, ratedW: 0, stoppedW: 0 };
      a.w += e.weight;
      a.wv += e.weight * e.value;
      if (e.rated) a.ratedW += e.weight;
      if (e.stopped) a.stoppedW += e.weight;
      acc.set(key, a);
    }
  }
  const signals = new Map<string, Signal>();
  for (const [key, a] of acc) {
    if (a.w < TASTE_MIN_SIGNAL) continue;
    const shrunk = (a.wv + TASTE_PRIOR_WEIGHT * mean) / (a.w + TASTE_PRIOR_WEIGHT);
    signals.set(key, {
      key,
      label: a.label,
      type: a.type,
      affinity: Math.round((shrunk - mean) * 1000) / 1000,
      evidence: Math.round(a.w * 10) / 10,
      rated: a.ratedW > a.w / 2,
      stopped: a.stoppedW > a.w / 2,
    });
  }
  return { active, outcomes: Math.round(outcomes * 10) / 10, groups, strength, signals };
}

/** Is taste changing anything right now? */
export const tasteOn = (m: TasteModel | null | undefined): m is TasteModel =>
  !!m && m.active && TASTE_STRENGTH[m.strength] > 0;

/** The taste component, 0–1 with 0.5 neutral, and the strongest liked signal to say why. */
export function tasteFor(
  i: Pick<TasteInput, 'kind' | 'creators' | 'subjects' | 'publisher'>,
  m: TasteModel | null | undefined,
): { score: number; reason: string | null } {
  if (!tasteOn(m)) return { score: 0.5, reason: null };
  const matched: Signal[] = [];
  for (const key of featuresOf(i).keys()) {
    const s = m.signals.get(key);
    if (s) matched.push(s);
  }
  if (matched.length === 0) return { score: 0.5, reason: null };
  const sum = matched.reduce((a, s) => a + s.affinity, 0);
  const x = (TASTE_STRENGTH[m.strength] * sum) / Math.sqrt(matched.length);
  const score = Math.round((0.5 + 0.5 * Math.tanh(2 * x)) * 1000) / 1000;
  // The reason names the most specific signal that stands out: an author says more than
  // "fiction", which would otherwise be the reason on nearly every card.
  const best = matched
    .filter((s) => s.affinity >= TASTE_REASON_MIN)
    .sort((a, b) => SPECIFIC[a.type] - SPECIFIC[b.type] || b.affinity - a.affinity)[0];
  return { score, reason: best ? signalSentence(best) : null };
}

const SPECIFIC: Record<Signal['type'], number> = {
  author: 0,
  artist: 1,
  genre: 2,
  publisher: 3,
  kind: 4,
};

/** A true sentence about a learned signal: "You rate fantasy highly", "You finish manga". */
export function signalSentence(s: Signal): string {
  const verb = s.rated ? 'You rate' : 'You finish';
  const tail = s.rated ? ' highly' : '';
  switch (s.type) {
    case 'author':
      return `${verb} books by ${s.label}${tail}`;
    case 'artist':
      return `${verb} comics drawn by ${s.label}${tail}`;
    case 'publisher':
      return `${verb} books from ${s.label}${tail}`;
    default:
      return `${verb} ${s.label}${tail}`;
  }
}

/** What taste has learned, strongest first, for Tune (§13.11 "Stats shows what it has learned"). */
export function tasteSummary(m: TasteModel) {
  const all = [...m.signals.values()];
  const likes = all
    .filter((s) => s.affinity >= TASTE_REASON_MIN)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 10);
  const dislikes = all
    .filter((s) => s.affinity <= -TASTE_REASON_MIN)
    .sort((a, b) => a.affinity - b.affinity)
    .slice(0, 6);
  return {
    active: m.active,
    outcomes: m.outcomes,
    groups: m.groups,
    threshold: TASTE_THRESHOLD,
    minGroups: TASTE_MIN_GROUPS,
    strength: m.strength,
    likes: likes.map((s) => ({ ...s, text: signalSentence(s) })),
    dislikes: dislikes.map((s) => ({ ...s, text: dislikeSentence(s) })),
  };
}

/**
 * A dislike, said only as strongly as its evidence allows. Standing below the owner's average
 * isn't dislike: finished, unrated books in a genre can sit below a run of 10/10s.
 *  - mostly "Not for me": You stopped books by X as "Not for me";
 *  - mostly ratings: You rate self-help lower than your other books;
 *  - otherwise: Below your average: mystery.
 */
export function dislikeSentence(s: Signal): string {
  const what =
    s.type === 'author'
      ? `books by ${s.label}`
      : s.type === 'artist'
        ? `comics drawn by ${s.label}`
        : s.type === 'publisher'
          ? `books from ${s.label}`
          : s.label;
  if (s.stopped) return `You stopped ${what} as “Not for me”`;
  if (s.rated) return `You rate ${what} lower than your other books`;
  return `Below your average: ${what}`;
}
