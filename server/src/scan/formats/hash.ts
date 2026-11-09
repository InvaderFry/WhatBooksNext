import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { PARTIAL_HASH_CHUNK } from '../../config.ts';

/**
 * Fingerprints (PLAN.md §20): the partial hash is SHA-256 over the size and the first and last
 * 64 KB — cheap. The full hash is SHA-256 of the whole file, read as a stream so memory stays
 * flat however large the file is.
 */
export function partialHash(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const h = createHash('sha256');
    h.update(`size:${size}\n`);
    const head = Buffer.alloc(Math.min(PARTIAL_HASH_CHUNK, size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (size > PARTIAL_HASH_CHUNK) {
      const tailLen = Math.min(PARTIAL_HASH_CHUNK, size - PARTIAL_HASH_CHUNK);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
    return h.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function fullHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
