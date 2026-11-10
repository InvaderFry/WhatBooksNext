import { describe, expect, it } from 'vitest';
import { Hardcover, parsePublishedSeries } from './hardcover.ts';
import { SERIES_PUBLICATION_LIMIT } from '../config.ts';
import { memoryDb } from '../testing/helpers.ts';

const entry = (position: number, over: Record<string, unknown> = {}) => ({
  position,
  compilation: false,
  book: {
    id: 100 + position,
    title: `Invented Storms ${position}`,
    release_date: '2024-05-17',
    canonical_id: null,
    is_partial_book: false,
    ...over,
  },
});
const payload = (rows: unknown[]) => ({
  data: { series_by_pk: { id: 42, name: 'Invented Storms', book_series: rows } },
});

describe('published series catalogues', () => {
  it('keeps explicit released primary volumes and never infers a range from a count', () => {
    const rows = [
      entry(1),
      entry(2),
      entry(4),
      entry(4),
      entry(1.5),
      entry(6, { release_date: '2099-01-01' }),
      entry(7, { release_date: null }),
      entry(8, { canonical_id: 99 }),
      entry(9, { is_partial_book: true }),
      { ...entry(10), compilation: true },
      entry(11, { release_date: '2024-02-31' }),
      null,
    ];
    const p = parsePublishedSeries(payload(rows), '42', 'Invented Storms', '2026-11-09');
    expect(p.entries.map((e) => e.position)).toEqual([1, 2, 4]);
    expect(p.entries[2]).toMatchObject({ title: 'Invented Storms 4', publishedOn: '2024-05-17' });
  });

  it('refuses wrong, malformed and truncated catalogues', () => {
    expect(() => parsePublishedSeries(payload([]), '99', 'Invented Storms')).toThrow(/verify/);
    expect(() => parsePublishedSeries(payload([]), '42', 'Another Story')).toThrow(/verify/);
    expect(() => parsePublishedSeries({}, '42', 'Invented Storms')).toThrow(/verify/);
    expect(() =>
      parsePublishedSeries(
        payload(Array.from({ length: SERIES_PUBLICATION_LIMIT + 1 }, () => entry(1))),
        '42',
        'Invented Storms',
      ),
    ).toThrow(/too large/);
  });

  it('identifies the series through the matched book and caches its actual volume list', async () => {
    const db = await memoryDb();
    const calls: { query: string; variables: Record<string, unknown>; authorization: string }[] =
      [];
    const hc = new Hardcover(
      db,
      () => 'Bearer private-token',
      async (_url, init) => {
        const body = JSON.parse(String(init.body));
        calls.push({
          ...body,
          authorization: (init.headers as Record<string, string>).authorization,
        });
        return Response.json(
          body.query.includes('SeriesMembership')
            ? {
                data: {
                  book_series: [
                    {
                      position: 1,
                      featured: true,
                      compilation: false,
                      series: { id: 42, name: 'Invented Storms' },
                    },
                  ],
                },
              }
            : payload([entry(1), entry(2), entry(3)]),
        );
      },
    );
    try {
      expect((await hc.publishedSeries('101', 'Invented Storms', 1)).entries).toHaveLength(3);
      await hc.publishedSeries('101', 'Invented Storms', 1);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        variables: { book: 101 },
        authorization: 'Bearer private-token',
      });
      expect(calls[1]!.query).toContain('release_date: {_lte: $today}');
      expect(calls[1]!.query).toContain('compilation: {_eq: false}');
      expect(calls[1]!.variables).toMatchObject({ id: 42, limit: SERIES_PUBLICATION_LIMIT + 1 });
      expect(db.prepare('SELECT key FROM source_cache').pluck().all().join(' ')).not.toContain(
        'private-token',
      );
    } finally {
      db.close();
    }
  });

  it('refuses ambiguous same-name series and a mismatched volume number', async () => {
    const hc = new Hardcover(
      null,
      () => 'token',
      async () =>
        Response.json({
          data: {
            book_series: [
              {
                position: 1,
                featured: false,
                compilation: false,
                series: { id: 42, name: 'Invented Storms' },
              },
              {
                position: 1,
                featured: false,
                compilation: false,
                series: { id: 43, name: 'Invented Storms' },
              },
            ],
          },
        }),
    );
    await expect(hc.publishedSeries('101', 'Invented Storms', 1)).rejects.toThrow(/confidently/);
    await expect(hc.publishedSeries('101', 'Invented Storms', 2)).rejects.toThrow(/confidently/);
  });

  it('refuses a compilation membership rather than calling its single issues volumes', async () => {
    const hc = new Hardcover(
      null,
      () => 'token',
      async () =>
        Response.json({
          data: {
            book_series: [
              null,
              {
                position: 1,
                featured: true,
                compilation: true,
                series: { id: 42, name: 'Invented Storms' },
              },
            ],
          },
        }),
    );
    await expect(hc.publishedSeries('101', 'Invented Storms', 1)).rejects.toThrow(/confidently/);
  });
});
