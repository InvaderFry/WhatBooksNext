import { describe, expect, it } from 'vitest';
import { searchMatcher } from './library.ts';

/** The Library search over titles, authors and series. Every name is invented. */

const book = (
  title: string,
  creators: string[] = [],
  series: string | null = null,
  factTitle = title,
) => ({
  title,
  factTitle,
  creators: creators.map((name) => ({ name })),
  series: series ? { id: 's1', name: series, position: 1, unit: 'volume' as const } : null,
});

const finds = (text: string, b: ReturnType<typeof book>) => searchMatcher(text)!(b);

describe('Library search', () => {
  const ledger = book('The Orchard Ledger', ['Mara Quillon', 'Tobias Venn'], 'Ledger Cycle');

  it('finds a book by its title, ignoring spaces and punctuation', () => {
    expect(finds('orchard ledger', ledger)).toBe(true);
    expect(finds('orchardledger', ledger)).toBe(true);
  });

  it('finds a book by any of its authors', () => {
    expect(finds('Mara Quillon', ledger)).toBe(true);
    expect(finds('venn', ledger)).toBe(true);
  });

  it('finds a book by its series', () => {
    expect(finds('ledger cycle', ledger)).toBe(true);
  });

  it('lets words land in different places, but needs every word somewhere', () => {
    expect(finds('orchard quillon', ledger)).toBe(true);
    expect(finds('orchard harbor', ledger)).toBe(false);
  });

  it('also searches the title the file gave, when the shown title differs', () => {
    expect(finds('copperline', book('Copperline #1 (2024)', [], null, 'copperline_001'))).toBe(
      true,
    );
  });

  it('ignores a search with nothing to look for', () => {
    expect(searchMatcher('  -- ')).toBeNull();
  });
});
