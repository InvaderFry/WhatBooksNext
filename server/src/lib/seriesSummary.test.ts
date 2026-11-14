import { describe, expect, it } from 'vitest';
import { seriesSummary, type SeriesEntry, type SeriesView } from './seriesView.ts';

const entry = (
  id: string,
  unit: 'volume' | 'issue',
  position: number,
  progress = 'not_started',
): SeriesEntry => ({
  id,
  title: `Invented Copper ${unit === 'issue' ? '#' : 'Vol. '}${position}`,
  position,
  label: String(position),
  unit,
  progress,
  holding: 'owned',
  availabilityLabel: null,
  formats: ['cbz'],
  via: null,
});

const view = (entries: SeriesEntry[]): SeriesView => ({
  id: 's1',
  name: 'Invented Copper',
  kind: 'comic',
  status: 'unknown',
  statusSource: null,
  ownerStatus: null,
  total: null,
  publications: null,
  orderSource: null,
  entries,
  gaps: [],
  coverage: [],
  missingAfter: null,
  unnumbered: 0,
});

describe('a series’ summary on the Series page', () => {
  it('offers collected volumes first when nothing in the series is started', () => {
    const s = seriesSummary(view([entry('v1', 'volume', 1), entry('i1', 'issue', 1)]));
    expect(s.next?.id).toBe('v1');
  });

  it('carries on with issues when the owner has been reading issues, as What next does', () => {
    const s = seriesSummary(
      view([
        entry('v1', 'volume', 1),
        entry('i1', 'issue', 1, 'finished'),
        entry('i2', 'issue', 2),
      ]),
    );
    expect(s).toMatchObject({ read: 1, owned: 3, next: { id: 'i2', unit: 'issue' } });
  });

  it('puts a book in progress next, and the owner’s finished/ongoing answer wins', () => {
    const v = view([entry('v1', 'volume', 1), entry('v2', 'volume', 2, 'halfway')]);
    v.ownerStatus = 'finished';
    expect(seriesSummary(v)).toMatchObject({ next: { id: 'v2' }, reading: 1, status: 'finished' });
  });

  it('counts published volumes not owned, and gaps, without counting a range twice', () => {
    const vol = (position: number) => ({
      position,
      title: `Invented Copper Vol. ${position}`,
      sourceId: `v${position}`,
      publishedOn: '2020-01-01',
    });
    const v = view([entry('v1', 'volume', 1), entry('v2', 'volume', 2)]);
    v.publications = {
      source: 'demo',
      checkedAt: '2026-11-14T00:00:00Z',
      volumes: [1, 2, 3, 4].map(vol),
      missing: [3, 4].map(vol),
      missingRanges: [{ from: 3, to: 4 }],
    } as SeriesView['publications'];
    v.gaps = [{ from: 5, to: 6, state: 'not_owned', unit: 'issue', text: 'Gap: issues 5–6' }];
    expect(seriesSummary(v).missing).toBe(4);
    v.publications = null;
    v.gaps = [
      { from: 3, to: 3, state: 'not_owned', unit: 'volume', text: '' },
      { from: 5, to: 6, state: 'maybe_covered', unit: 'issue', text: '' },
    ];
    v.missingAfter = { from: 5, to: 6 };
    expect(seriesSummary(v).missing).toBe(3);
  });
});
