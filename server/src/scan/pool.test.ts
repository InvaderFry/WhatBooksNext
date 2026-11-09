import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCbr, makeCbz } from '../testing/fixtures.ts';
import { tempDir } from '../testing/helpers.ts';
import { TaskError, WorkerPool } from './pool.ts';

const dir = tempDir('wbn-pool-');
const pool = new WorkerPool(2);
afterAll(async () => {
  await pool.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('worker pool', () => {
  it('reads files in worker threads', async () => {
    const cbz = path.join(dir, 'a.cbz');
    const cbr = path.join(dir, 'b.cbr');
    fs.writeFileSync(cbz, makeCbz({ pages: 3 }));
    fs.writeFileSync(cbr, makeCbr({ pages: 4 }));
    const [a, b] = await Promise.all([
      pool.run(
        { kind: 'read', file: cbz, format: 'cbz', ext: 'cbz', wantCover: false },
        { timeoutMs: 60_000 },
      ),
      pool.run(
        { kind: 'read', file: cbr, format: 'cbr', ext: 'cbr', wantCover: false },
        { timeoutMs: 60_000 },
      ),
    ]);
    expect(a.kind === 'read' && a.meta.pageCount).toBe(3);
    expect(b.kind === 'read' && b.meta.pageCount).toBe(4);
  });

  it('reports a reader error without losing the worker', async () => {
    const bad = path.join(dir, 'bad.cbz');
    fs.writeFileSync(bad, 'nope');
    await expect(
      pool.run(
        { kind: 'read', file: bad, format: 'cbz', ext: 'cbz', wantCover: false },
        { timeoutMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(TaskError);
    const r = await pool.run({ kind: 'full_hash', file: bad }, { timeoutMs: null });
    expect(r.kind === 'full_hash' && r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stops a task that runs past its time limit and replaces the worker', async () => {
    const big = path.join(dir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7));
    await expect(
      pool.run({ kind: 'full_hash', file: big }, { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      reason: 'timeout',
    });
    const r = await pool.run({ kind: 'full_hash', file: big }, { timeoutMs: null });
    expect(r.kind).toBe('full_hash');
  });

  it('cancels running and queued tasks on abort', async () => {
    const big = path.join(dir, 'big.bin');
    const p = [1, 2, 3].map(() => pool.run({ kind: 'full_hash', file: big }, { timeoutMs: null }));
    pool.abort();
    for (const x of p) await expect(x).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
