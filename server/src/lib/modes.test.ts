import { describe, expect, it } from 'vitest';
import { item, measured, page, rated, rough, series, situation } from '../testing/rank.ts';
import { MODE_IDS, runMode, stillReadingDue, surprise, versionIn } from './modes.ts';
import { completeness } from './recommend.ts';
import { learnTaste } from './taste.ts';

const ids = (r: { cards: { id: string }[] }) => r.cards.map((c) => c.id);

describe('every mode (§13.10)', () => {
  it('uses the shared eligibility: Never, hidden, DNF, finished and history-only never appear', () => {
    const out = [
      item({ user: { triage: 'never' }, community: rated(95) }),
      item({ user: { hidden: true }, community: rated(95) }),
      item({ user: { progress: 'dnf', dnfReason: 'not_now' }, community: rated(95) }),
      item({ user: { progress: 'finished' }, community: rated(95) }),
      item({ historyOnly: true, community: rated(95), firstPublishYear: 1950 }),
    ];
    for (const m of MODE_IDS) expect(ids(runMode(m, out, situation(), page))).toEqual([]);
  });

  it('offers one installment per series in every list', () => {
    const all = [1, 2, 3].map((n) =>
      item({
        series: series('s', n),
        community: rated(90),
        firstPublishYear: 1960,
        duration: measured(60),
        acquired: { date: '2020-01-01', basis: 'entered' },
      }),
    );
    all.push(item({ series: series('s', 0.5), user: { progress: 'finished' } }));
    for (const m of ['read_next', 'waiting', 'classics', 'one_sitting', 'mood'] as const)
      expect(ids(runMode(m, all, situation(), page))).toEqual([all[0]!.id]);
  });

  it('keeps unplugged and iCloud-only books recommendable with a label, and Ready to read drops them (scenario 5)', () => {
    const away = item({
      community: rated(90),
      availability: {
        state: 'unreachable',
        label: 'On external drive (not connected)',
        alsoInICloud: false,
        readyToRead: false,
      },
    });
    const here = item({ community: rated(85) });
    const r = runMode('read_next', [away, here], situation(), page);
    expect(ids(r)).toContain(away.id);
    expect(r.cards.find((c) => c.id === away.id)!.limitations).toContain(
      'on external drive (not connected)',
    );
    expect(ids(runMode('read_next', [away, here], situation({ readyToRead: true }), page))).toEqual(
      [here.id],
    );
  });

  it('excludes a DNF "Not now" without teaching dislike, and makes it eligible again when restored (scenario 7)', () => {
    const fantasy = { subjects: ['Fantasy'] };
    const book = item({ ...fantasy, user: { progress: 'dnf', dnfReason: 'not_now' } });
    expect(ids(runMode('read_next', [book], situation(), page))).toEqual([]);
    const t = learnTaste([
      {
        id: book.id,
        kind: 'fiction',
        creators: book.creators,
        subjects: ['Fantasy'],
        seriesKey: null,
        historyOnly: false,
        progress: 'dnf',
        dnfReason: 'not_now',
        rating: null,
      },
    ]);
    expect(t.signals.size).toBe(0);
    book.user.progress = 'not_started';
    book.user.dnfReason = null;
    expect(ids(runMode('read_next', [book], situation(), page))).toEqual([book.id]);
  });
});

describe('Continue reading', () => {
  it('puts shortlisted books first in shortlist order, then nearly done, halfway, into it and sampled', () => {
    const sampled = item({ user: { progress: 'sampled', progressAt: '2026-11-09T10:00:00Z' } });
    const nearly = item({ user: { progress: 'nearly_done', progressAt: '2026-01-01T10:00:00Z' } });
    const halfOld = item({ user: { progress: 'halfway', progressAt: '2026-02-01T10:00:00Z' } });
    const halfNew = item({ user: { progress: 'halfway', progressAt: '2026-10-01T10:00:00Z' } });
    const listed2 = item({ user: { progress: 'sampled', shortlistPosition: 2 } });
    const listed1 = item({ user: { progress: 'into_it', shortlistPosition: 1 } });
    const notStarted = item();
    const r = runMode(
      'continue',
      [sampled, nearly, halfOld, halfNew, listed2, listed1, notStarted],
      situation(),
      page,
    );
    expect(ids(r)).toEqual([listed1.id, listed2.id, nearly.id, halfNew.id, halfOld.id, sampled.id]);
    expect(r.cards[0]!.reasons[0]).toBe('On your shortlist');
  });

  it('says plainly when nothing is in progress', () => {
    const r = runMode('continue', [item()], situation(), page);
    expect(r.cards).toEqual([]);
    expect(r.empty).toMatch(/Nothing in progress/);
  });
});

describe('Next in series', () => {
  it('offers the skipped earlier volume of a started series first, and ignores unstarted series', () => {
    const v1 = item({ series: series('a', 1), user: { progress: 'finished' } });
    const v2 = item({ series: series('a', 2) });
    const v3 = item({ series: series('a', 3), user: { progress: 'finished' } });
    const v4 = item({ series: series('a', 4) });
    const other = item({ series: series('b', 1) });
    expect(ids(runMode('next_in_series', [v1, v2, v3, v4, other], situation(), page))).toEqual([
      v2.id,
    ]);
  });

  it('counts a volume read elsewhere as starting the series, and warns about a gap without blocking', () => {
    const elsewhere = item({
      series: series('c', 1),
      historyOnly: true,
      user: { progress: 'finished' },
    });
    const v3 = item({ series: series('c', 3) });
    const r = runMode('next_in_series', [elsewhere, v3], situation(), page);
    expect(ids(r)).toEqual([v3.id]);
    expect(r.cards[0]!.gaps[0]!.text).toMatch(/volume 2/);
  });
});

describe('One-sitting reads', () => {
  it('keeps only measured lengths that fit two hours by default, with rough ones apart', () => {
    const short = item({ duration: measured(90) });
    const long = item({ duration: measured(300) });
    const roughShort = item({ duration: rough(60) });
    const unknown = item();
    const r = runMode('one_sitting', [short, long, roughShort, unknown], situation(), page);
    expect(ids(r)).toEqual([short.id]);
    expect(r.mightFit.map((c) => c.id)).toEqual([roughShort.id]);
  });

  it('uses the picked time instead of two hours', () => {
    const short = item({ duration: measured(25) });
    const hour = item({ duration: measured(50) });
    const r = runMode('one_sitting', [short, hour], situation({ budget: 30 }), page);
    expect(ids(r)).toEqual([short.id]);
  });
});

describe('Waiting on your shelf', () => {
  it('lists highly rated unstarted books, longest waiting first, ties by rating, unknown dates last', () => {
    const old = item({
      community: rated(85),
      acquired: { date: '2019-03-01', basis: 'file_date' },
    });
    const newer = item({
      community: rated(95),
      acquired: { date: '2024-01-01', basis: 'entered' },
    });
    const sameDayBetter = item({
      community: rated(95),
      acquired: { date: '2019-03-01', basis: 'file_date' },
    });
    const unknown = item({ community: rated(99) });
    const notHigh = item({
      community: rated(60),
      acquired: { date: '2010-01-01', basis: 'entered' },
    });
    const started = item({ community: rated(99), user: { progress: 'sampled' } });
    const r = runMode(
      'waiting',
      [old, newer, sameDayBetter, unknown, notHigh, started],
      situation(),
      page,
    );
    expect(ids(r)).toEqual([sameDayBetter.id, old.id, newer.id, unknown.id]);
    expect(r.cards[0]!.reasons[0]).toBe('On your shelf since 2019-03-01 (from the file date)');
    expect(r.cards[3]!.limitations).toContain('when you got it is unknown');
  });
});

describe('Hidden gems', () => {
  it('needs a high rating with few votes for its source, and never counts unknown votes as obscurity', () => {
    const gem = item({ community: rated(90, { votes: 12, fewVotes: true }) });
    const popular = item({ community: rated(92) });
    const unknownVotes = item({ community: rated(92, { votes: null, fewVotes: false }) });
    const seriesGem = item({ community: rated(92, { votes: 9, fewVotes: true, scope: 'series' }) });
    const lowGem = item({ community: rated(60, { votes: 9, fewVotes: true }) });
    const r = runMode(
      'hidden_gems',
      [gem, popular, unknownVotes, seriesGem, lowGem],
      situation(),
      page,
    );
    expect(ids(r)).toEqual([gem.id]);
    expect(r.cards[0]!.reasons.join(' ')).toMatch(/Only 12 ratings on Hardcover/);
  });
});

describe('Classics you missed', () => {
  it('never includes a book the owner has started or finished (scenario 16)', () => {
    const classic = item({ community: rated(90), firstPublishYear: 1970 });
    const finished = item({
      community: rated(90),
      firstPublishYear: 1960,
      user: { progress: 'finished' },
    });
    const sampled = item({
      community: rated(90),
      firstPublishYear: 1960,
      user: { progress: 'sampled' },
    });
    const reset = item({
      community: rated(90),
      firstPublishYear: 1960,
      user: { startedOn: '2025-01-01', startedPrecision: 'exact' },
    });
    const recent = item({ community: rated(95), firstPublishYear: 2010 });
    const unknownYear = item({ community: rated(95) });
    const r = runMode(
      'classics',
      [classic, finished, sampled, reset, recent, unknownYear],
      situation(),
      page,
    );
    expect(ids(r)).toEqual([classic.id]);
    expect(r.cards[0]!.reasons).toContain('First published in 1970');
  });

  it('draws the line at 25 years', () => {
    const edge = item({ community: rated(90), firstPublishYear: 2001 });
    const young = item({ community: rated(90), firstPublishYear: 2002 });
    expect(ids(runMode('classics', [edge, young], situation(), page))).toEqual([edge.id]);
  });
});

describe('Still relevant?', () => {
  it('finds the version a title names, without mistaking editions or ordinary words', () => {
    expect(versionIn('Learning React 16 the Hard Way')).toBe('React 16');
    expect(versionIn('Python 3.12 Pocket Notes')).toBe('Python 3.12');
    expect(versionIn('HTML5 Canvas Patterns')).toBe('HTML 5');
    expect(versionIn('Mastering Visual Studio 2010')).toBe('Visual Studio 2010');
    expect(versionIn('ES6 in Practice')).toBe('ES 6');
    expect(versionIn('Office 2016 Explained')).toBe('Office 2016');
    expect(versionIn('Learning Python, 5th Edition')).toBeNull();
    expect(versionIn('Word 2 Word: Essays')).toBeNull();
    expect(versionIn('Go 2 Places')).toBeNull();
    expect(versionIn('Structure and Interpretation of Invented Programs')).toBeNull();
  });

  it('orders version-specific first, then books outside your topics, then oldest, and states signals without judging (scenario 9)', () => {
    const tech = (title: string, year: number | null, over = {}) =>
      item({ title, kind: 'tech', firstPublishYear: year, ...over });
    const fundamentals = tech('Invented Algorithms Fundamentals', 1985);
    const versioned = tech('Invented Guide to React 16', 2018);
    const outside = tech('Invented Spreadsheet Habits', 2015);
    const onTopicNew = tech('Invented Rust Patterns', 2022);
    const decided = tech('Invented Wanted Book', 2000, { user: { triage: 'want' } });
    const later = tech('Invented Later Book', 1990, {
      user: { relevanceDeferredAt: '2026-11-01' },
    });
    const s = situation({ topics: ['Rust', 'algorithms'] });
    const r = runMode(
      'still_relevant',
      [fundamentals, versioned, outside, onTopicNew, decided, later],
      s,
      page,
    );
    expect(ids(r)).toEqual([versioned.id, outside.id, fundamentals.id, onTopicNew.id, later.id]);
    const f = r.cards.find((c) => c.id === fundamentals.id) as unknown as { signals: string[] };
    expect(f.signals).toEqual([
      'Published 1985 (41 years ago)',
      'About algorithms, one of your topics',
    ]);
    expect(f.signals.join(' ')).not.toMatch(/stale|obsolete|outdated/i);
    // And it's recommended like any other book: age is no penalty in Read next.
    const rn = runMode('read_next', [fundamentals, onTopicNew], situation(), page);
    const [a, b] = rn.cards;
    expect(a!.score).toBe(b!.score);
  });
});

describe('Mood', () => {
  it('re-weights rather than filters: Learn lifts nonfiction above better-rated fiction, which stays', () => {
    const novel = item({ kind: 'fiction', community: rated(90) });
    const essay = item({ kind: 'nonfiction', community: rated(70) });
    const r = runMode('mood', [novel, essay], situation({ mood: 'learn' }), page);
    expect(ids(r)).toEqual([essay.id, novel.id]);
    expect(r.cards[0]!.reasons).toContain('Something to learn from: nonfiction');
  });

  it('brings reference books into Skim only', () => {
    const ref = item({ kind: 'tech', isReference: true });
    const shortStory = item({ duration: measured(30) });
    expect(ids(runMode('read_next', [ref], situation(), page))).toEqual([]);
    expect(ids(runMode('mood', [ref, shortStory], situation({ mood: 'escape' }), page))).toEqual([
      shortStory.id,
    ]);
    const skim = runMode('mood', [ref, shortStory], situation({ mood: 'skim' }), page);
    expect(ids(skim).sort()).toEqual([ref.id, shortStory.id].sort());
  });
});

describe('Surprise me', () => {
  const books = () =>
    Array.from({ length: 60 }, (_, k) => item({ community: rated(40 + k), title: `Pick ${k}` }));

  it('picks only from the top 50 of Read next', () => {
    const all = books();
    const bottom = new Set(all.slice(0, 10).map((i) => i.id));
    for (let k = 0; k < 50; k++) {
      const r = surprise(all, situation(), { ...page, rng: () => k / 50 });
      expect(bottom.has(r.cards[0]!.id)).toBe(false);
    }
  });

  it('never shows the previous pick again straight away', () => {
    const all = books().slice(0, 2);
    const first = surprise(all, situation(), { ...page, rng: () => 0 }).cards[0]!.id;
    for (const x of [0, 0.5, 0.999])
      expect(
        surprise(all, situation(), { ...page, rng: () => x, previous: [first] }).cards[0]!.id,
      ).not.toBe(first);
  });

  it('favours higher scores in proportion to the score squared', () => {
    const hi = item({ community: rated(100), user: { triage: 'want' } });
    const lo = item({ community: rated(50) });
    const s = situation();
    const counts = { hi: 0, lo: 0 };
    for (let k = 0; k < 1000; k++) {
      const id = surprise([hi, lo], s, { ...page, rng: () => (k + 0.5) / 1000 }).cards[0]!.id;
      counts[id === hi.id ? 'hi' : 'lo']++;
    }
    const r = runMode('read_next', [hi, lo], s, page).cards;
    const [a, b] = [r[0]!.score ** 2, r[1]!.score ** 2];
    expect(counts.hi / 1000).toBeCloseTo(a / (a + b), 2);
  });
});

describe('Complete stories only (§13.3)', () => {
  it('keeps standalone books and finished series you fully own, and says why others fail', () => {
    const standalone = item();
    const full = [1, 2].map((n) =>
      item({ series: series('full', n, { status: 'finished', total: 2 }) }),
    );
    const missing = [1, 3].map((n) =>
      item({ series: series('gap', n, { status: 'finished', total: 3 }) }),
    );
    const ongoing = item({ series: series('on', 1, { status: 'ongoing' }) });
    const unknown = item({ series: series('unk', 1) });
    const all = [standalone, ...full, ...missing, ongoing, unknown];
    expect(completeness(missing[0]!, all)).toEqual({
      ok: false,
      why: 'missing',
      text: 'you’re missing vol. 2',
    });
    expect(completeness(ongoing, all)).toMatchObject({ ok: false, text: 'story ongoing' });
    const r = runMode('read_next', all, situation({ completeOnly: true }), page);
    expect(ids(r).sort()).toEqual([standalone.id, full[0]!.id].sort());
    expect(r.leftOut).toEqual({ ongoing: 1, unknown: 1, missing: 1 });
  });

  it('counts a volume read elsewhere as part of a complete story', () => {
    const v1 = item({
      series: series('x', 1, { status: 'finished', total: 2 }),
      historyOnly: true,
      user: { progress: 'finished' },
    });
    const v2 = item({ series: series('x', 2, { status: 'finished', total: 2 }) });
    expect(completeness(v2, [v1, v2])).toEqual({ ok: true });
  });
});

describe('Topic interests', () => {
  it('shows only books about the chosen topic, reference included', () => {
    const ref = item({ kind: 'tech', isReference: true, title: 'Invented Rust Reference' });
    const novel = item({ title: 'An Invented Voyage' });
    const r = runMode(
      'read_next',
      [ref, novel],
      situation({ topics: ['Rust'], topic: 'Rust' }),
      page,
    );
    expect(ids(r)).toEqual([ref.id]);
    expect(r.cards[0]!.reasons).toContain('About Rust, one of your topics');
  });
});

describe('Still reading? (§13.6)', () => {
  it('gathers books untouched for 90 days into one list, unless snoozed', () => {
    const stale = item({ user: { progress: 'halfway', progressAt: '2026-07-01T10:00:00Z' } });
    const fresh = item({ user: { progress: 'halfway', progressAt: '2026-10-01T10:00:00Z' } });
    const snoozed = item({
      user: {
        progress: 'sampled',
        progressAt: '2026-01-01T10:00:00Z',
        stillReadingSnoozedUntil: '2026-12-01',
      },
    });
    const noDate = item({ user: { progress: 'into_it' } });
    expect(stillReadingDue([stale, fresh, snoozed, noDate], '2026-11-10').map((i) => i.id)).toEqual(
      [stale.id],
    );
  });
});
