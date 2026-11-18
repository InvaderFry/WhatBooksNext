import { describe, expect, it } from 'vitest';
import { listenFromFiles } from './library.ts';

const part = (relPath: string, seconds: number | null, bookDir = 'Book', size = 100) => ({
  relPath,
  seconds,
  bookDir,
  size,
});

describe('an audiobook’s total playing time', () => {
  it('counts differently sized encodings once, using the longer known time in either order', () => {
    const parts = [part('Book/Title.mp3', 600), part('Book/Title.M4B', 602, 'Book', 200)];
    expect(listenFromFiles(parts)).toEqual({ minutes: 10, parts: 1 });
    expect(listenFromFiles(parts.toReversed())).toEqual(listenFromFiles(parts));
  });

  it('can use a readable encoding when the other encoding’s time is unknown', () => {
    expect(listenFromFiles([part('Book/Title.mp3', null), part('Book/Title.m4b', 600)])).toEqual({
      minutes: 10,
      parts: 1,
    });
  });

  it('keeps the total unknown when another distinct part has no playing time', () => {
    expect(
      listenFromFiles([
        part('Book/CD 1/01.mp3', 600),
        part('Book/CD 1/01.wav', 600),
        part('Book/CD 2/01.mp3', null),
      ]),
    ).toEqual({ minutes: null, parts: 2 });
  });
});
