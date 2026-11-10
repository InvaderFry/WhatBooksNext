import { describe, expect, it } from 'vitest';
import { toRanges, viaStates, type ViaItem } from './coverage.ts';
import { gapSentence, seriesGaps, type Coverage, type SeriesMember } from './series.ts';

/** Collected editions and their issues (§12.5), pure rules. All names invented. */

const issue = (n: number, holding: SeriesMember['holding'] = 'owned'): SeriesMember => ({
  id: `i${n}`,
  position: n,
  unit: 'issue',
  holding,
});
const trade = (over: Partial<Coverage> = {}): Coverage => ({
  id: 'cov1',
  itemId: 'tpb1',
  title: 'Copperline Vol. 1',
  first: 1,
  last: 6,
  state: 'confirmed',
  held: true,
  ...over,
});

describe('gaps with collected editions (§12.5)', () => {
  it('fills issue gaps with a confirmed collection the owner has', () => {
    // Issues 2, 4 and 8 owned; the trade holds 1–6: only 7 is missing.
    const g = seriesGaps([issue(2), issue(4), issue(8)], 'issue', [trade()]);
    expect(g).toEqual([{ from: 7, to: 7, state: 'not_owned', unit: 'issue' }]);
  });

  it('says a suggested collection may cover a gap, and asks to confirm (scenario 4)', () => {
    const [g] = seriesGaps([issue(2), issue(4)], 'issue', [trade({ state: 'suggested' })]);
    expect(g).toMatchObject({
      from: 3,
      to: 3,
      state: 'maybe_covered',
      coveredBy: { itemId: 'tpb1', title: 'Copperline Vol. 1', coverageId: 'cov1' },
    });
    expect(gapSentence(g!, 2)).toBe('Gap ahead: issue 3 may be in Copperline Vol. 1. Confirm?');
  });

  it('ignores a collection the owner doesn’t have', () => {
    expect(seriesGaps([issue(2), issue(4)], 'issue', [trade({ held: false })])).toEqual([
      { from: 3, to: 3, state: 'not_owned', unit: 'issue' },
    ]);
  });

  it('merges runs of numbers into ranges', () => {
    expect(toRanges([5, 1, 2, 3, 3, 6, 1.5])).toEqual([
      { first: 1, last: 3 },
      { first: 5, last: 6 },
    ]);
  });
});

describe('reading shared between collections and issues (§12.5)', () => {
  const items = (over: Record<string, Partial<ViaItem>> = {}): ViaItem[] =>
    [
      { id: 'tpb1', seriesKey: 's', unit: 'volume' as const, position: 1, finished: false },
      ...[1, 2, 3].map((n) => ({
        id: `i${n}`,
        seriesKey: 's',
        unit: 'issue' as const,
        position: n,
        finished: false,
      })),
    ].map((i) => ({ ...i, ...over[i.id] }));
  const cov = (state: 'confirmed' | 'suggested' = 'confirmed') => [
    { itemId: 'tpb1', first: 1, last: 3, state, seriesKey: 's' },
  ];

  it('marks covered issues read via the collection once it is finished (scenario 20)', () => {
    const v = viaStates(items({ tpb1: { finished: true }, i2: { finished: true } }), cov());
    expect(Object.fromEntries(v)).toEqual({ i1: 'collection', i3: 'collection' });
  });

  it('counts the collection read once every issue in it is read', () => {
    const all = { i1: { finished: true }, i2: { finished: true }, i3: { finished: true } };
    expect(viaStates(items(all), cov()).get('tpb1')).toBe('issues');
    expect(viaStates(items({ i1: { finished: true } }), cov()).size).toBe(0);
  });

  it('gives a suggested collection none of these effects', () => {
    expect(viaStates(items({ tpb1: { finished: true } }), cov('suggested')).size).toBe(0);
  });
});
