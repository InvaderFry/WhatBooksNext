import { describe, expect, it } from 'vitest';
import type { RankItem, Situation } from './recommend.ts';
import { whyNot } from './whyNot.ts';

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
  title: `Invented Book ${n}`,
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

const ser = (key: string, position: number): NonNullable<RankItem['series']> => ({
  key,
  name: `Invented ${key}`,
  position,
  label: String(position),
  unit: 'volume',
  status: 'unknown',
  total: null,
});

const situation = (over: Partial<Situation> = {}): Situation => ({
  budget: null,
  mode: 'read_for',
  readyToRead: false,
  exclude: new Set(),
  today: '2026-11-14',
  recentDays: 60,
  ...over,
});

describe('Why isn’t this book shown?', () => {
  it('says where a shown book is, and nothing else', () => {
    const a = item();
    const r = whyNot([a, item()], situation(), 'read_next', a.id)!;
    expect(r.position).not.toBeNull();
    expect(r.reasons).toEqual([]);
  });

  it('stops at eligibility: a Never book gets that reason only, with a link to its page', () => {
    const a = item({ kind: 'comic', user: user({ triage: 'never' }) });
    const r = whyNot([a], situation({ show: 'books' }), 'read_next', a.id)!;
    expect(r.reasons).toEqual([
      {
        text: 'You marked it Never. You can change that on its page.',
        fix: { kind: 'item', id: a.id, label: 'Open its page' },
      },
    ]);
  });

  it('names every filter that keeps a book out, each with the choice that would let it in', () => {
    const a = item({
      kind: 'comic',
      availability: {
        state: 'not_connected',
        label: 'On external drive (not connected)',
        alsoInICloud: false,
        readyToRead: false,
      },
    });
    const r = whyNot([a], situation({ show: 'books', readyToRead: true }), 'read_next', a.id)!;
    expect(r.position).toBeNull();
    expect(r.reasons.map((x) => x.fix)).toEqual([
      { kind: 'choice', key: 'show', value: '', label: 'Show all kinds' },
      { kind: 'choice', key: 'ready', value: '', label: 'Include books that aren’t ready' },
    ]);
    expect(r.reasons[0]!.text).toContain('this is a comic');
    expect(r.reasons[1]!.text).toContain('On external drive (not connected)');
  });

  it('points to the installment offered first when one per series holds a book back', () => {
    const one = item({ title: 'Invented Saga 1', series: ser('saga', 1) });
    const two = item({ title: 'Invented Saga 2', series: ser('saga', 2) });
    const r = whyNot([one, two], situation(), 'read_next', two.id)!;
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]!.text).toContain('“Invented Saga 1” (vol. 1) comes first in Invented saga');
    expect(r.reasons[0]!.fix).toEqual({
      kind: 'item',
      id: one.id,
      label: 'Open “Invented Saga 1”',
    });
  });

  it('doesn’t repeat a number the title already gives', () => {
    const one = item({ title: 'Invented Saga #1', series: { ...ser('saga', 1), unit: 'issue' } });
    const two = item({ title: 'Invented Saga #2', series: { ...ser('saga', 2), unit: 'issue' } });
    const r = whyNot([one, two], situation(), 'read_next', two.id)!;
    expect(r.reasons[0]!.text).toContain('and “Invented Saga #1” comes first');
  });

  it('explains Complete stories only with the reason the series fails', () => {
    const a = item({ series: ser('saga', 1) });
    const r = whyNot([a], situation({ completeOnly: true }), 'read_next', a.id)!;
    expect(r.reasons[0]).toMatchObject({
      text: '“Complete stories only” is on, and not known whether the story is finished.',
      fix: { key: 'complete', value: '' },
    });
  });

  it('says a book is too long or of unknown length when finishing within a time', () => {
    const long = item({
      duration: { low: 500, high: 600, basis: 'from 150,000 words', measured: true, unit: 'book' },
    });
    const unknown = item();
    const s = situation({ budget: 60, mode: 'finish_within' });
    expect(whyNot([long, unknown], s, 'read_next', long.id)!.reasons[0]!.text).toBe(
      'It’s too long to finish in the time chosen.',
    );
    expect(whyNot([long, unknown], s, 'read_next', unknown.id)!.reasons[0]!.text).toContain(
      'Its length isn’t known',
    );
  });

  it('says “might fit” only for the books that section shows, and explains the rest', () => {
    // Twelve estimated lengths that might fit in an hour: the section shows the first ten.
    const rough = Array.from({ length: 12 }, (_, k) =>
      item({
        title: `Invented Rough ${String(k + 1).padStart(2, '0')}`,
        duration: { low: 30, high: 80, basis: 'from 40 pages', measured: false, unit: 'book' },
      }),
    );
    const s = situation({ budget: 60, mode: 'finish_within' });
    const results = rough.map((b) => whyNot(rough, s, 'read_next', b.id)!);
    const shown = results.filter((x) => x.mightFit);
    expect(shown).toHaveLength(10);
    const beyond = results.filter((x) => !x.mightFit);
    expect(beyond).toHaveLength(2);
    for (const x of beyond) {
      expect(x.reasons[0]!.text).toMatch(/number 1[12] of those\. What next shows only the top 10/);
      expect(x.reasons[0]!.fix).toMatchObject({ key: 'mode', value: '' });
    }
  });

  it('gives the mode’s own rule when the book is eligible but the mode doesn’t take it', () => {
    const a = item();
    const r = whyNot([a], situation(), 'continue', a.id)!;
    expect(r.reasons[0]!.text).toMatch(
      /^It isn’t in Continue reading\. That list’s rule: Books you’ve started/,
    );
    expect(r.reasons[0]!.fix).toEqual({
      kind: 'choice',
      key: 'm',
      value: '',
      label: 'Show Read next',
    });
  });

  it('says a reference book shows only in Skim, a topic or Still relevant?', () => {
    const a = item({ kind: 'tech', isReference: true });
    const r = whyNot([a], situation(), 'read_next', a.id)!;
    expect(r.reasons[0]!.text).toContain('reference book');
  });

  it('returns nothing for a book that doesn’t exist', () => {
    expect(whyNot([item()], situation(), 'read_next', 'nope')).toBeNull();
  });
});
