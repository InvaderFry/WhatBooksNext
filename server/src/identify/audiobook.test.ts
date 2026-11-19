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
    expect(books('x', ['Glass Orchard 01.mp3', 'Glass Orchard 02.mp3'])).toEqual(['x|x', 'x|x']);
  });

  it('keeps numeric titles apart in the library folder itself, and a lone one intact', () => {
    expect(books('', ['4027.mp3', 'Lantern Saga 3.mp3'])).toEqual(['|4027', '|Lantern Saga 3']);
    expect(books('Books', ['4027.mp3'])).toEqual(['Books|4027']);
  });

  it('reads numbered MP3s sharing a name in one folder as that folder’s chapters', () => {
    // Owner decision 2026-11-19: folder first. Separate books keep their own folders.
    expect(books('Lantern Saga', ['Lantern Saga 3.mp3', 'Lantern Saga 4.mp3'])).toEqual([
      'Lantern Saga|Lantern Saga',
      'Lantern Saga|Lantern Saga',
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

describe('the layouts seen on the owner’s drive (invented names)', () => {
  const one = (dir: string, names: string[]) => [...new Set(books(dir, names))];

  it('joins chapters named after a series and book', () => {
    expect(
      one('Saga/1 - The Glass Orchard', [
        'SAGA - Book 1 - The Glass Orchard - 00 - Prologue.mp3',
        'SAGA - Book 1 - The Glass Orchard - 01 - Wren.mp3',
      ]),
    ).toEqual(['Saga/1 - The Glass Orchard|The Glass Orchard']);
  });

  it('joins "1 of 4", "(01 of 08)", "[01] --" and "Chapter 01" chapters', () => {
    for (const names of [
      ['Ann Author - The Salt Road - 1 of 4.mp3', 'Ann Author - The Salt Road - 2 of 4.mp3'],
      ['The Salt Road - Ann Author (01 of 08).mp3', 'The Salt Road - Ann Author (02 of 08).mp3'],
      ['The Salt Road (Ann Author) [01] -- Intro.MP3', 'The Salt Road (Ann Author) [02] -- On.MP3'],
      ['Chapter 01 - The Gate.mp3', 'Chapter 02 - The Well.mp3'],
    ])
      expect(one('The Salt Road', names)).toEqual(['The Salt Road|The Salt Road']);
  });

  it('joins chapters numbered in unusual ways', () => {
    for (const names of [
      ['0.00.1 Credits.mp3', '1.01.1 A Party.mp3'],
      ['01 0301.mp3', '02 0302.mp3'],
      ['01(4) The Salt Road.mp3', '02(4) The Salt Road.mp3'],
      ['B02-01-12 - The Salt Road.mp3', 'B02-02-12 - The Salt Road.mp3'],
      ['001_ 01_(1 51) The Salt Road (Unabridged) Part 1_Ann.mp3', '002_ 02_(1 51) Part 1_Ann.mp3'],
      ['SALT521P01.mp3', 'SALT521P02.mp3', 'Credits.mp3'],
    ])
      expect(one('The Salt Road', names)).toEqual(['The Salt Road|The Salt Road']);
  });

  it('drops a leading list number and "unabridged" from the folder’s name', () => {
    expect(
      one('Spy Books/03 - Ann Author - The Salt Road_unabridged', [
        '01(4) The Salt Road.mp3',
        '02(4) The Salt Road.mp3',
      ]),
    ).toEqual(['Spy Books/03 - Ann Author - The Salt Road_unabridged|Ann Author - The Salt Road']);
  });

  it('joins "Title Disc N" folders, and a title folder inside each disc', () => {
    expect([
      ...one('Ann Author/The Salt Road Disc 1', ['Track 1.mp3', 'Track 2.mp3']),
      ...one('Ann Author/The Salt Road Disc 2', ['Track 1.mp3']),
    ]).toEqual(['Ann Author|The Salt Road', 'Ann Author|The Salt Road']);
    expect([
      ...one('Saga/Ember/Ember Disc 1/Ember', ['1 - Opening.mp3', '2 - Disk 1 Track 2.mp3']),
      ...one('Saga/Ember/Ember Disc 10/Ember', ['1 - Disk10 Track1.mp3']),
    ]).toEqual(['Saga/Ember|Ember', 'Saga/Ember|Ember']);
  });

  it('passes a generic "Audiobook" folder to the folder above', () => {
    expect(
      one('Ann Author - The Salt Road/Audiobook', [
        'The Salt Road - Disc 1.mp3',
        'The Salt Road - Disc 2.mp3',
      ]),
    ).toEqual(['Ann Author - The Salt Road|The Salt Road']);
  });

  it('joins chapters named in mixed styles', () => {
    expect(one('The Glass Orchard', ['01 - Dawn.mp3', '02 - Dusk.mp3', 'Chapter 3.mp3'])).toEqual([
      'The Glass Orchard|The Glass Orchard',
    ]);
  });

  it('still joins leading-number chapters beside a differently numbered file', () => {
    expect(
      books('The Glass Orchard', ['01 - Dawn.mp3', '02 - Dusk.mp3', 'Salt Road Sampler 3.mp3']),
    ).toEqual([
      'The Glass Orchard|The Glass Orchard',
      'The Glass Orchard|The Glass Orchard',
      'The Glass Orchard|Salt Road Sampler 3',
    ]);
  });

  it('reads Audible download names without codec or account, joining their parts', () => {
    expect(
      books('Audible', [
        'TheSaltRoadUnabridged_mp332_someone.name.aa',
        'GlassOrchardUnabridgedPart1_mp332_someone.aa',
        'GlassOrchardUnabridgedPart2_mp332_someone.aa',
      ]),
    ).toEqual(['Audible|The Salt Road', 'Audible|Glass Orchard', 'Audible|Glass Orchard']);
  });

  it('still keeps differently named whole-book files apart', () => {
    expect(books('Audible', ['The Salt Road.m4b', 'Glass Orchard.m4b'])).toEqual([
      'Audible|The Salt Road',
      'Audible|Glass Orchard',
    ]);
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
