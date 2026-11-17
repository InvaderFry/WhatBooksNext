import { describe, expect, it } from 'vitest';
import {
  audioBooksInDirectory,
  comparePartPaths,
  formatListen,
  inAudiobookDirs,
} from './audiobook.ts';

const books = (dir: string, names: string[], root = 'Audiobooks') => {
  const m = audioBooksInDirectory(dir, names, root);
  return names.map((n) => `${m.get(n)!.bookDir}|${m.get(n)!.bookName}`);
};

describe('which audio files make one audiobook', () => {
  it('treats numbered chapter files as the book their folder is named for', () => {
    expect(
      books('Ann Author - The Glass Orchard', ['01 - Dawn.mp3', '02 - Dusk.mp3', '03 - Night.mp3']),
    ).toEqual(Array(3).fill('Ann Author - The Glass Orchard|Ann Author - The Glass Orchard'));
  });

  it('joins files with explicit part numbers, named by what they share', () => {
    expect(books('', ['The Glass Orchard Part 1.mp3', 'The Glass Orchard Part 2.mp3'])).toEqual([
      '|The Glass Orchard',
      '|The Glass Orchard',
    ]);
    expect(books('x', ['Glass Orchard 01.mp3', 'Glass Orchard 02.mp3'])).toEqual([
      'x|Glass Orchard 01',
      'x|Glass Orchard 02',
    ]);
  });

  it('preserves numeric titles and keeps them apart in one folder', () => {
    expect(books('Books', ['4027.mp3', '13-24-57.mp3'])).toEqual(['Books|4027', 'Books|13-24-57']);
  });

  it('keeps numbered MP3 books separate even when their series names match', () => {
    expect(books('Lantern Saga', ['Lantern Saga 3.mp3', 'Lantern Saga 4.mp3'])).toEqual([
      'Lantern Saga|Lantern Saga 3',
      'Lantern Saga|Lantern Saga 4',
    ]);
  });

  it('preserves numbers in the book title while joining explicitly named parts', () => {
    expect(books('Books', ['Lantern 22 Part 1.mp3', 'Lantern 22 Part 2.mp3'])).toEqual([
      'Books|Lantern 22',
      'Books|Lantern 22',
    ]);
  });

  it('gives files with nothing but a track number to the folder', () => {
    expect(books('The Glass Orchard', ['Track 01.mp3', 'Track 02.mp3', 'Chapter 3.mp3'])).toEqual(
      Array(3).fill('The Glass Orchard|The Glass Orchard'),
    );
  });

  it('recognises short zero-padded track names without stripping other numeric titles', () => {
    expect(books('The Glass Orchard', ['01.mp3', '02.mp3'])).toEqual([
      'The Glass Orchard|The Glass Orchard',
      'The Glass Orchard|The Glass Orchard',
    ]);
    expect(books('Books', ['4027.mp3'])).toEqual(['Books|4027']);
  });

  it('takes a disc folder’s book from the folder above, so discs join up', () => {
    expect(books('The Glass Orchard/CD 1', ['01 Opening.mp3', 'Credits.mp3'])).toEqual(
      Array(2).fill('The Glass Orchard|The Glass Orchard'),
    );
    expect(books('The Glass Orchard/Disc2', ['01 Later.mp3'])).toEqual([
      'The Glass Orchard|The Glass Orchard',
    ]);
  });

  it('keeps whole-book files apart, even numbered ones in a series folder', () => {
    expect(
      books('Lantern Saga', [
        '01 The Glass Orchard.m4b',
        '02 The Salt Road.m4b',
        'Lantern Saga 3.m4b',
        'Lantern Saga 4.m4b',
      ]),
    ).toEqual([
      'Lantern Saga|01 The Glass Orchard',
      'Lantern Saga|02 The Salt Road',
      'Lantern Saga|Lantern Saga 3',
      'Lantern Saga|Lantern Saga 4',
    ]);
  });

  it('joins a whole-book format only on a named part', () => {
    expect(books('', ['The Salt Road Part 1.m4b', 'The Salt Road Part 2.m4b'])).toEqual([
      '|The Salt Road',
      '|The Salt Road',
    ]);
  });

  it('keeps differently named files without track numbers as separate books', () => {
    expect(books('', ['The Glass Orchard.mp3', 'The Salt Road.mp3'])).toEqual([
      '|The Glass Orchard',
      '|The Salt Road',
    ]);
  });

  it('names chapter files lying in the library folder itself by that folder', () => {
    expect(books('', ['01 Dawn.mp3', '02 Dusk.mp3'], 'The Glass Orchard')).toEqual(
      Array(2).fill('|The Glass Orchard'),
    );
  });

  it('keeps a single numbered file as its own book', () => {
    expect(books('x', ['01 The Glass Orchard.mp3'])).toEqual(['x|01 The Glass Orchard']);
  });
});

describe('audiobook folders', () => {
  it('covers a directory and everything below it, ignoring case', () => {
    expect(inAudiobookDirs('Audio/Book', ['audio'])).toBe(true);
    expect(inAudiobookDirs('Audio', ['audio'])).toBe(true);
    expect(inAudiobookDirs('Audio2', ['audio'])).toBe(false);
    expect(inAudiobookDirs('Music', [''])).toBe(true);
    expect(inAudiobookDirs('Music', [])).toBe(false);
  });
});

describe('listening order and time', () => {
  it('sorts part 2 before part 10', () => {
    expect(['b/10.mp3', 'b/2.mp3', 'a/1.mp3'].sort(comparePartPaths)).toEqual([
      'a/1.mp3',
      'b/2.mp3',
      'b/10.mp3',
    ]);
  });

  it('writes a playing time exactly', () => {
    expect(formatListen(45)).toBe('45 min');
    expect(formatListen(120)).toBe('2 h');
    expect(formatListen(552)).toBe('9 h 12 min');
  });
});
