import { describe, expect, it } from 'vitest';
import { gapSentence, missingAfter, seriesGaps, type SeriesMember } from './series.ts';

const vol = (
  position: number | null,
  holding: SeriesMember['holding'] = 'owned',
): SeriesMember => ({
  id: `v${position}`,
  position,
  unit: 'volume',
  holding,
});
const issue = (position: number, holding: SeriesMember['holding'] = 'owned'): SeriesMember => ({
  ...vol(position, holding),
  unit: 'issue',
});

describe('series gaps (§12.5)', () => {
  it('finds volume 3 missing when volumes 1, 2 and 4 are owned', () => {
    expect(seriesGaps([vol(1), vol(2), vol(4)], 'volume')).toEqual([
      { from: 3, to: 3, state: 'not_owned', unit: 'volume' },
    ]);
  });

  it('counts volumes from 1, so owning only volume 4 leaves 1–3 missing', () => {
    expect(seriesGaps([vol(4)], 'volume')).toEqual([
      { from: 1, to: 3, state: 'not_owned', unit: 'volume' },
    ]);
  });

  it('lets a volume read elsewhere fill its gap', () => {
    expect(seriesGaps([vol(1), vol(2, 'read_elsewhere'), vol(3)], 'volume')).toEqual([]);
  });

  it('reports an owned volume whose files are all missing as unavailable, not as not owned', () => {
    const [g] = seriesGaps([vol(1), vol(2, 'unavailable'), vol(3)], 'volume');
    expect(g).toMatchObject({ from: 2, to: 2, state: 'unavailable' });
    expect(gapSentence(g!, 3)).toBe('Gap: volume 2 is owned, but the file is missing.');
  });

  it('counts issues only between issues the owner has, since runs often start part-way', () => {
    expect(seriesGaps([issue(13), issue(14), issue(17)], 'issue')).toEqual([
      { from: 15, to: 16, state: 'not_owned', unit: 'issue' },
    ]);
  });

  it('ignores installments with no number and side stories like 1.5', () => {
    expect(seriesGaps([vol(1), vol(1.5), vol(null), vol(2)], 'volume')).toEqual([]);
    expect(seriesGaps([vol(null)], 'volume')).toEqual([]);
  });

  it('does not list thousands of gaps for a number that is really a year', () => {
    expect(seriesGaps([issue(1), issue(2019)], 'issue')).toEqual([]);
  });

  it('says a gap before the installment and a gap ahead of it differently', () => {
    const g = { from: 3, to: 3, state: 'not_owned' as const, unit: 'volume' as const };
    expect(gapSentence(g, 4)).toBe('Gap: volume 3 isn’t recorded as owned or read.');
    expect(gapSentence(g, 1)).toBe('Gap ahead: volume 3 isn’t recorded as owned or read.');
    expect(gapSentence({ ...g, to: 5 }, 1)).toBe(
      'Gap ahead: volumes 3–5 aren’t recorded as owned or read.',
    );
  });

  it('knows which volumes a finished story has past the last one owned', () => {
    expect(missingAfter([vol(1), vol(2)], 'volume', 4)).toEqual({ from: 3, to: 4 });
    expect(missingAfter([vol(1), vol(2)], 'volume', null)).toBeNull();
  });
});
