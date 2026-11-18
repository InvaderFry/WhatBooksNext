import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMp3 } from '../../testing/fixtures.ts';
import { tempDir } from '../../testing/helpers.ts';
import { readAudio } from './audio.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// MPEG-1 Layer III, 32 kHz: 1,152 samples (36 ms) per frame. Change bitrate after
// the opening frames, so a reader that assumes CBR from those frames gets the wrong time.
function mp3(varyBitrate: boolean, header?: 'Xing' | 'Info') {
  const frames = Array.from({ length: 100 }, (_, n) => {
    const high = varyBitrate && n >= 4;
    const frame = Buffer.alloc(high ? 288 : 144);
    frame.set([0xff, 0xfb, high ? 0x28 : 0x18, 0xc0]);
    return frame;
  });
  if (header) {
    // Mono side information occupies 17 bytes after the four-byte frame header.
    frames[0]!.write(header, 21);
    frames[0]!.writeUInt32BE(3, 25); // frame count and stream size are present
    frames[0]!.writeUInt32BE(frames.length, 29);
    frames[0]!.writeUInt32BE(
      frames.reduce((n, f) => n + f.length, 0),
      33,
    );
  }
  return Buffer.concat(frames);
}

async function read(bytes: Buffer) {
  const dir = tempDir('wbn-audio-length-');
  dirs.push(dir);
  const file = path.join(dir, 'The Glass Orchard.mp3');
  fs.writeFileSync(file, bytes);
  return readAudio(file, 'mp3', false);
}

describe('MP3 playing times', () => {
  it('counts all frames when the opening bitrates match but later frames differ', async () => {
    expect((await read(mp3(true))).durationSeconds).toBeCloseTo(3.6, 2);
  });

  it('still measures a constant bitrate recording without a length header', async () => {
    expect((await read(mp3(false))).durationSeconds).toBeCloseTo(3.6, 2);
  });

  it.each(['Xing', 'Info'] as const)('reads a %s duration header', async (header) => {
    expect((await read(mp3(header === 'Xing', header))).durationSeconds).toBeCloseTo(3.6, 2);
  });

  it('keeps the book tags when measuring a recording', async () => {
    const r = await read(makeMp3(1, { album: 'The Glass Orchard', artist: 'Ann Author' }));
    expect(r.metadata).toMatchObject({
      title: 'The Glass Orchard',
      creators: [{ name: 'Ann Author', role: 'author' }],
    });
    expect(r.durationSeconds).toBeCloseTo(1, 1);
  });
});
