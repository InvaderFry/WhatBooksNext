import { parentPort } from 'node:worker_threads';
import { runTask, type Task } from './formats/index.ts';

/**
 * A deep-pass worker thread (PLAN.md §6.1): runs one content-reading task at a time and posts
 * the result back. Parsing, counting, thumbnails and hashing happen here, off the main thread,
 * so the UI stays responsive during a scan.
 */
parentPort!.on('message', (msg: { id: number; task: Task }) => {
  runTask(msg.task).then(
    (result) => parentPort!.postMessage({ id: msg.id, ok: true, result }),
    (err: unknown) => {
      const e = err as Error & { limit?: string };
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: e?.message ?? String(err),
        limit: e?.limit,
      });
    },
  );
});
