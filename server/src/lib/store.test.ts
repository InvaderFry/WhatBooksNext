import { describe, expect, it } from 'vitest';
import { normIsbn } from './store.ts';

/** ISBNs as imports and the Add a store book form give them. */

describe('normIsbn', () => {
  it('keeps an ISBN-13 or ISBN-10 whose check digit is right, however it is written', () => {
    expect(normIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(normIsbn('0306406152')).toBe('0306406152');
    expect(normIsbn('0-8044-2957-x')).toBe('080442957X');
  });

  it('treats an ISBN whose check digit is wrong as no ISBN', () => {
    expect(normIsbn('9780306406158')).toBeNull();
    expect(normIsbn('0306406153')).toBeNull();
    expect(normIsbn('1234567890123')).toBeNull();
  });

  it('treats blanks and other lengths as no ISBN', () => {
    expect(normIsbn('')).toBeNull();
    expect(normIsbn(null)).toBeNull();
    expect(normIsbn('12345')).toBeNull();
  });
});
