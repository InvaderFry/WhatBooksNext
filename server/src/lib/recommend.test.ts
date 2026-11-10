import { describe, expect, it } from 'vitest';
import { estimateDuration, formatRange } from './estimate.ts';
import { communityRating, ratingStats, shrink } from './ratings.ts';
import {
  buildCard,
  diversify,
  fitOf,
  onePerSeries,
  type RankItem,
  type Situation,
} from './recommend.ts';
import { readNext } from './modes.ts';

const user = (over: Partial<RankItem['user']> = {}): RankItem['user'] => ({
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
const item = (over: Partial<RankItem> = {}): RankItem => ({
  id: `i${++n}`,
  title: `Book ${n}`,
  kind: 'fiction',
  isReference: false,
  creators: [],
  coverFileId: null,
  formats: ['epub'],
  availability: { state: 'present', label: null, alsoInICloud: false, readyToRead: true },
  user: user(),
  identity: 'accepted',
  matchConfirmed: false,
  historyOnly: false,
  series: null,
  duration: null,
  community: null,
  firstPublishYear: null,
  acquired: { date: null, basis: 'unknown' },
  effort: 'unknown',
  ...over,
});

const ser = (
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

const situation = (over: Partial<Situation> = {}): Situation => ({
  budget: null,
  mode: 'read_for',
  readyToRead: false,
  exclude: new Set(),
  today: '2026-11-09',
  recentDays: 60,
  ...over,
});

const page = { offset: 0, limit: 10 };

describe('durations (§12.3)', () => {
  it('estimates prose from words at the kind’s reading speed, as a ±20% range', () => {
    const d = estimateDuration({ kind: 'fiction', words: 78_000, pages: null })!;
    // 78,000 ÷ 260 wpm = 300 min.
    expect(d).toMatchObject({ low: 240, high: 360, measured: true, basis: 'from 78,000 words' });
    expect(formatRange(d)).toBe('~4–6 h');
  });

  it('marks a length from pages × assumed words a page as rough, never measured', () => {
    const d = estimateDuration({ kind: 'nonfiction', words: null, pages: 300 })!;
    expect(d.measured).toBe(false);
    expect(d.basis).toMatch(/assuming 275 words a page/);
  });

  it('measures comics from their page count', () => {
    const d = estimateDuration({ kind: 'comic', words: null, pages: 24 }, 'issue')!;
    expect(d).toMatchObject({ measured: true, unit: 'issue', low: 6, high: 10 });
  });

  it('measures a PDF that is mostly pictures by its pages, not its few words', () => {
    // A comic PDF with a thin text layer: 741 words over 150 pages is not a 3-minute read.
    const d = estimateDuration({ kind: 'fiction', words: 741, pages: 150, pdfType: 'uncertain' })!;
    expect(d.basis).toBe('from 150 pages, mostly pictures');
    expect(d.measured).toBe(false);
    expect(d.low).toBeGreaterThan(30);
  });

  it('says unknown rather than guessing when there is nothing to go on', () => {
    expect(estimateDuration({ kind: 'fiction', words: null, pages: null })).toBeNull();
  });
});

describe('ratings (§12.2)', () => {
  it('shrinks a score with few votes toward the source’s own mean', () => {
    const s = { mean: 76, medianVotes: 100 };
    expect(shrink({ value: 5, scale: 5, count: 1, scope: 'book' }, s)).toBeCloseTo(76.2, 1);
    expect(shrink({ value: 5, scale: 5, count: 10_000, scope: 'book' }, s)).toBeGreaterThan(99);
  });

  it('never pools sources: each has its own mean and "highly rated" line', () => {
    const stats = ratingStats([
      { source: 'openlibrary', value: 4, scale: 5, count: 10, scope: 'book' },
      { source: 'anilist', value: 70, scale: 100, count: 10, scope: 'series' },
    ]);
    expect(stats.get('openlibrary')!.mean).toBe(80);
    expect(stats.get('anilist')!.mean).toBe(70);
  });

  it('prefers Hardcover, then AniList, then Open Library', () => {
    const stats = ratingStats([]);
    const r = communityRating(
      [
        { source: 'openlibrary', value: 4.5, scale: 5, count: 10, scope: 'book' },
        { source: 'hardcover', value: 3.9, scale: 5, count: 400, scope: 'book' },
      ],
      stats,
    );
    expect(r!.source).toBe('hardcover');
  });
});

describe('Read next', () => {
  const longNovel = () =>
    item({
      title: 'A Long Owned Novel',
      duration: estimateDuration({ kind: 'fiction', words: 180_000, pages: null }),
    });

  it('can suggest a long owned novel for "Read for 30 minutes", labelled with its full length (scenario 1)', () => {
    const r = readNext([longNovel()], situation({ budget: 30, mode: 'read_for' }), page);
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.scope).toMatch(/Whole book · ~9–14 h/);
    expect(r.cards[0]!.reasons).toContain('Good for a 30-minute session');
  });

  it('never calls a rough 25–40 minute estimate a confident fit for "Finish within 30 minutes" (scenario 2)', () => {
    const rough = item({
      title: 'Short PDF',
      duration: { low: 25, high: 40, basis: 'from 10 pages', measured: false, unit: 'book' },
    });
    const s = situation({ budget: 30, mode: 'finish_within' });
    expect(fitOf(rough.duration, s)).toBe('might_fit');
    const r = readNext([rough], s, page);
    expect(r.cards).toHaveLength(0);
    expect(r.mightFit.map((c) => c.title)).toEqual(['Short PDF']);
    expect(r.mightFit[0]!.limitations).toContain('rough length');
  });

  it('puts a measured short book that fits in the main list, saying it can be finished', () => {
    const short = item({
      duration: { low: 16, high: 24, basis: 'from 5,200 words', measured: true, unit: 'book' },
    });
    const r = readNext([short], situation({ budget: 30, mode: 'finish_within' }), page);
    expect(r.cards[0]!.reasons).toContain('You can finish it within 30 minutes');
  });

  it('orders unrated books by time fit, triage and momentum when no ratings exist (scenario 22)', () => {
    const plain = item({ title: 'Plain' });
    const wanted = item({ title: 'Wanted', user: user({ triage: 'want' }) });
    const started = item({ title: 'Started', user: user({ progress: 'halfway' }) });
    const r = readNext([plain, wanted, started], situation(), page);
    expect(r.cards.map((c) => c.title)).toEqual(['Started', 'Wanted', 'Plain']);
    // Missing data never produces a positive reason (§13.8).
    expect(r.cards.find((c) => c.title === 'Plain')!.reasons).toEqual([]);
  });

  it('scores an unknown rating as neutral, not last', () => {
    const unrated = item({ title: 'Unrated' });
    const poor = item({
      title: 'Poorly rated',
      community: {
        source: 'openlibrary',
        raw: 2,
        scale: 5,
        votes: 500,
        scope: 'book',
        score: 40,
        highlyRated: false,
        fewVotes: false,
      },
    });
    const r = readNext([poor, unrated], situation(), page);
    expect(r.cards[0]!.title).toBe('Unrated');
  });

  it('leaves out finished, Never, hidden, DNF, reference and history-only items', () => {
    const r = readNext(
      [
        item({ title: 'Finished', user: user({ progress: 'finished' }) }),
        item({ title: 'Never', user: user({ triage: 'never' }) }),
        item({ title: 'Hidden', user: user({ hidden: true }) }),
        item({ title: 'DNF', user: user({ progress: 'dnf', dnfReason: 'not_now' }) }),
        item({ title: 'Reference', isReference: true }),
        item({ title: 'Read elsewhere', historyOnly: true }),
        item({ title: 'Eligible' }),
      ],
      situation(),
      page,
    );
    expect(r.cards.map((c) => c.title)).toEqual(['Eligible']);
  });

  it('offers only the next installment of a series, an in-progress one first', () => {
    const s = (pos: number, progress = 'not_started') =>
      item({
        title: `Saga vol. ${pos}`,
        series: ser('saga', pos),
        user: user({ progress }),
      });
    expect(onePerSeries([s(2), s(1), s(3)]).map((i) => i.title)).toEqual(['Saga vol. 1']);
    expect(onePerSeries([s(1, 'finished'), s(2), s(3, 'into_it')]).map((i) => i.title)).toEqual([
      'Saga vol. 3',
    ]);
  });

  it('offers a collected volume before single issues, unless the owner is reading the issues', () => {
    const vol = item({ title: 'Saga Vol. 1', series: ser('saga', 1) });
    const iss = (n: number, progress = 'not_started') =>
      item({
        title: `Saga #${n}`,
        series: ser('saga', n, { unit: 'issue' }),
        user: user({ progress }),
      });
    expect(onePerSeries([vol, iss(1), iss(2)]).map((i) => i.title)).toEqual(['Saga Vol. 1']);
    const all = [vol, iss(1, 'finished'), iss(2)];
    expect(
      onePerSeries(
        all.filter((i) => i.user.progress !== 'finished'),
        all,
      ).map((i) => i.title),
    ).toEqual(['Saga #2']);
  });

  it('treats an installment with no number as a standalone book', () => {
    const numbered = item({ title: 'Saga vol. 1', series: ser('saga', 1) });
    const special = item({ title: 'Saga: a side story', series: ser('saga', null) });
    expect(
      onePerSeries([numbered, special])
        .map((i) => i.title)
        .sort(),
    ).toEqual(['Saga vol. 1', 'Saga: a side story']);
  });

  // Scenario 3: owning volumes 1, 2 and 4 warns about volume 3 before volume 1 is started;
  // after volume 2, volume 4 is selectable with the warning; volume 3 is never shown as owned.
  it('warns about a missing volume before the series is started, and again at the next volume', () => {
    const v = (pos: number, progress = 'not_started') =>
      item({ title: `Saga vol. ${pos}`, series: ser('saga', pos), user: user({ progress }) });
    const before = [v(1), v(2), v(4)];
    const first = readNext(before, situation(), page).cards;
    expect(first.map((c) => c.title)).toEqual(['Saga vol. 1']);
    expect(first[0]!.gaps.map((g) => g.text)).toEqual([
      'Gap ahead: volume 3 isn’t recorded as owned or read.',
    ]);
    expect(first[0]!.scope).toMatch(/^Starts a series · vol\. 1 · 3 owned · /);

    const after = [v(1, 'finished'), v(2, 'finished'), v(4)];
    const next = readNext(after, situation(), page).cards;
    expect(next.map((c) => c.title)).toEqual(['Saga vol. 4']);
    expect(next[0]!.gaps).toMatchObject([
      { from: 3, to: 3, text: 'Gap: volume 3 isn’t recorded as owned or read.' },
    ]);
    expect(next[0]!.scope).toMatch(/^Next in series · vol\. 4 · /);
  });

  it('drops the warning once the missing volume is marked read elsewhere', () => {
    const v = (pos: number, over: Partial<RankItem> = {}) =>
      item({ title: `Saga vol. ${pos}`, series: ser('saga', pos), ...over });
    const all = [
      v(1, { user: user({ progress: 'finished' }) }),
      v(2, { user: user({ progress: 'finished' }) }),
      v(3, {
        historyOnly: true,
        availability: { state: 'none', label: null, alsoInICloud: false, readyToRead: false },
        user: user({ progress: 'finished' }),
      }),
      v(4),
    ];
    const cards = readNext(all, situation(), page).cards;
    expect(cards.map((c) => c.title)).toEqual(['Saga vol. 4']);
    expect(cards[0]!.gaps).toEqual([]);
  });

  it('says how many of a finished story’s volumes are owned, and whether it is finished', () => {
    const v = (pos: number) =>
      item({
        title: `Saga vol. ${pos}`,
        series: ser('saga', pos, { status: 'finished', total: 6 }),
      });
    const c = readNext([v(1), v(2)], situation(), page).cards[0]!;
    expect(c.scope).toMatch(/^Starts a series · vol\. 1 · 2 of 6 owned · .* · story finished$/);
  });

  it('keeps unavailable books recommendable, with their label as a limitation', () => {
    const away = item({
      availability: {
        state: 'not_connected',
        label: 'On external drive (not connected)',
        alsoInICloud: false,
        readyToRead: false,
      },
    });
    expect(readNext([away], situation(), page).cards[0]!.limitations).toContain(
      'on external drive (not connected)',
    );
    expect(readNext([away], situation({ readyToRead: true }), page).cards).toHaveLength(0);
  });

  it('labels a series score as the series’ and an unconfirmed match as unconfirmed', () => {
    const manga = item({
      kind: 'manga',
      identity: 'provisional',
      series: ser('x', 1),
      community: {
        source: 'anilist',
        raw: 88,
        scale: 100,
        votes: 9000,
        scope: 'series',
        score: 88,
        highlyRated: true,
        fewVotes: false,
      },
    });
    const c = buildCard(manga, [manga], situation());
    expect(c.reasons[0]).toBe('Series rated 88/100 on AniList from 9,000 ratings');
    expect(c.limitations).toEqual(
      expect.arrayContaining(['unconfirmed match', 'rating is for the whole series']),
    );
  });

  it('mixes authors: one author’s bundle doesn’t fill the top of the list', () => {
    const by = (name: string, score: number) => ({
      ...buildCard(item({ creators: [{ name }] }), [], situation()),
      score,
      title: `${name} ${score}`,
    });
    const order = diversify([
      by('Ana Reyes', 0.6),
      by('Ana Reyes', 0.59),
      by('Ana Reyes', 0.58),
      by('Ben Ortiz', 0.57),
      by('Cy Park', 0.56),
    ]).map((c) => c.title);
    expect(order.slice(0, 3)).toEqual(['Ana Reyes 0.6', 'Ben Ortiz 0.57', 'Cy Park 0.56']);
    // A clearly better book by the same author still comes first.
    expect(
      diversify([by('Ana Reyes', 0.9), by('Ana Reyes', 0.85), by('Ben Ortiz', 0.5)])[1]!.title,
    ).toBe('Ana Reyes 0.85');
  });

  it('measures a comic with lettered balloons (about 60 words a page) by its pages', () => {
    const d = estimateDuration({ kind: null, words: 7_500, pages: 120 })!;
    expect(d.basis).toBe('from 120 pages, mostly pictures');
  });

  it('shows books, tech books, comics and manga, or everything', () => {
    const all = [
      item({ title: 'Novel', kind: 'fiction' }),
      item({ title: 'Comic', kind: 'comic' }),
      item({ title: 'Manga', kind: 'manga' }),
      item({ title: 'Unknown', kind: null }),
      item({ title: 'Programming', kind: 'tech' }),
    ];
    const titles = (show: Situation['show']) =>
      readNext(all, situation({ show }), page)
        .cards.map((c) => c.title)
        .sort();
    expect(titles('books')).toEqual(['Novel', 'Unknown']);
    expect(titles('comics')).toEqual(['Comic', 'Manga']);
    expect(titles('tech')).toEqual(['Programming']);
    expect(titles('all')).toHaveLength(5);
  });

  it('hides a book the owner isn’t in the mood for, for this session only', () => {
    const a = item({ title: 'Not now' });
    const b = item({ title: 'Other' });
    const r = readNext([a, b], situation({ exclude: new Set([a.id]) }), page);
    expect(r.cards.map((c) => c.title)).toEqual(['Other']);
  });
});
