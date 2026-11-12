import { describe, expect, it } from 'vitest';
import { parseHardcover } from './hardcover.ts';
import { parseMetronIssues } from './metron.ts';
import { parseComicVineIssues } from './comicvine.ts';
import { parseOpenLibrary } from './openlibrary.ts';
import { parseAniList } from './anilist.ts';
import { sourceCoverUrl } from './covers.ts';
import { candidateView } from '../lib/identityReview.ts';

describe('source covers for visual comparisons', () => {
  it('reads Hardcover image objects and serialized image objects', () => {
    for (const image of [
      { url: 'https://cdn.hardcover.app/cover.jpg' },
      JSON.stringify({ url: 'https://cdn.hardcover.app/cover.jpg' }),
    ]) {
      const [book] = parseHardcover({
        data: { search: { results: { hits: [{ document: { id: 1, title: 'Example', image } }] } } },
      });
      expect(book?.coverUrl).toBe('https://cdn.hardcover.app/cover.jpg');
    }
  });
  it('keeps cover URLs from each comic/manga source and Open Library', () => {
    expect(
      parseMetronIssues({
        results: [
          {
            id: 1,
            number: '1',
            series: { name: 'Example' },
            image: 'https://static.metron.cloud/media/cover.jpg',
          },
        ],
      })[0]?.coverUrl,
    ).toBe('https://static.metron.cloud/media/cover.jpg');
    expect(
      parseComicVineIssues({
        results: [
          {
            id: 1,
            issue_number: '1',
            volume: { name: 'Example' },
            image: { medium_url: 'https://comicvine.gamespot.com/a/uploads/cover.jpg' },
          },
        ],
      })[0]?.coverUrl,
    ).toContain('/a/uploads/cover.jpg');
    expect(
      parseOpenLibrary({ docs: [{ key: '/works/OL1W', title: 'Example', cover_i: 123 }] })[0]
        ?.coverUrl,
    ).toBe('https://covers.openlibrary.org/b/id/123-M.jpg?default=false');
    expect(
      parseAniList({
        data: {
          Page: {
            media: [
              {
                id: 1,
                title: { english: 'Example' },
                coverImage: { large: 'https://s4.anilist.co/file/cover.jpg' },
              },
            ],
          },
        },
      })[0]?.coverUrl,
    ).toBe('https://s4.anilist.co/file/cover.jpg');
  });
  it('never invents a missing cover and rejects arbitrary, credentialed, local, or insecure image URLs', () => {
    expect(
      parseHardcover({
        data: { search: { results: { hits: [{ document: { id: 1, title: 'Example' } }] } } },
      })[0]?.coverUrl,
    ).toBeUndefined();
    for (const url of [
      'http://cdn.hardcover.app/a.jpg',
      'https://127.0.0.1/a.jpg',
      'file:///etc/passwd',
      'data:image/png;base64,a',
      'https://attacker.example/a.jpg',
      'https://cdn.hardcover.app.attacker.example/a.jpg',
      'https://user:secret@cdn.hardcover.app/a.jpg',
      'https://cdn.hardcover.app:8443/a.jpg',
    ])
      expect(sourceCoverUrl('hardcover', url)).toBeUndefined();
  });
  it('revalidates stored candidate cover URLs before exposing them to the browser', () => {
    const [record] = parseMetronIssues({
      results: [{ id: 1, number: '1', series: { name: 'Example' } }],
    });
    const candidate = candidateView({
      record: { ...record!, coverUrl: 'https://attacker.example/cover.jpg' },
      score: 0.85,
      evidence: { title: 1, author: 'unknown', isbn: 'none', notes: [] },
    });
    expect(candidate.coverUrl).toBeNull();
  });
});
