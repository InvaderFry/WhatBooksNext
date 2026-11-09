import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { MAX_WORKERS, WORKER_HEAP_MB } from '../config.ts';
import type { Task, TaskResult } from './formats/index.ts';

/**
 * A small worker_threads pool for content reading (PLAN.md §6.1, §20).
 *
 *  - Size: CPU cores − 1, at most 4.
 *  - Each worker's JavaScript heap is capped. That cap doesn't limit native memory (canvas,
 *    WASM), so per-file limits are also checked before decoding, and only one "large" task
 *    runs at a time across the pool.
 *  - A task over its time limit has its worker terminated and is reported as timed out; a
 *    fresh worker replaces it. Full hashing passes no limit (§20) but can still be aborted.
 */

export class TaskError extends Error {
  /** 'timeout' | 'cancelled' | 'crashed' | a reader's limit name ('ratio', 'size', …) */
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface RunOptions {
  /** Time limit in ms; null for none (full hashing). */
  timeoutMs: number | null;
  /** A large file: only one runs at a time across the pool. */
  large?: boolean;
}

/** What the deep pass needs from a pool; tests can wrap it to watch every content read. */
export interface TaskRunner {
  readonly size: number;
  run(task: Task, opts: RunOptions): Promise<TaskResult>;
  /** Stops every running task now (cancel). */
  abort(): void;
  close(): Promise<void>;
}

interface Slot {
  worker: Worker | null;
  busy: boolean;
}

interface Job {
  task: Task;
  opts: RunOptions;
  resolve: (r: TaskResult) => void;
  reject: (e: Error) => void;
}

const WORKER_URL = new URL('./worker.ts', import.meta.url);

export function defaultPoolSize(): number {
  return Math.max(1, Math.min(MAX_WORKERS, os.availableParallelism() - 1));
}

export class WorkerPool implements TaskRunner {
  readonly size: number;
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private largeRunning = false;
  private nextId = 1;
  private readonly running = new Map<Slot, { job: Job; timer: NodeJS.Timeout | null }>();
  private closed = false;

  constructor(size = defaultPoolSize()) {
    this.size = size;
    this.slots = Array.from({ length: size }, () => ({ worker: null, busy: false }));
  }

  run(task: Task, opts: RunOptions): Promise<TaskResult> {
    if (this.closed) return Promise.reject(new TaskError('cancelled', 'The pool is closed.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ task, opts, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const i = this.queue.findIndex((j) => !j.opts.large || !this.largeRunning);
      if (i < 0) return;
      const job = this.queue.splice(i, 1)[0]!;
      this.start(slot, job);
    }
  }

  private spawn(): Worker {
    const w = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    // An idle worker never keeps the app (or a test run) alive on its own.
    w.unref();
    return w;
  }

  private start(slot: Slot, job: Job) {
    slot.busy = true;
    if (job.opts.large) this.largeRunning = true;
    const worker = (slot.worker ??= this.spawn());
    const id = this.nextId++;
    const finish = (fn: () => void) => {
      const r = this.running.get(slot);
      if (!r || r.job !== job) return;
      if (r.timer) clearTimeout(r.timer);
      this.running.delete(slot);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      slot.busy = false;
      if (job.opts.large) this.largeRunning = false;
      fn();
      this.pump();
    };
    const kill = (reason: string, message: string) => {
      if (slot.worker === worker) slot.worker = null;
      void worker.terminate();
      finish(() => job.reject(new TaskError(reason, message)));
    };
    const onMessage = (m: {
      id: number;
      ok: boolean;
      result?: TaskResult;
      error?: string;
      limit?: string;
    }) => {
      if (m.id !== id) return;
      finish(() =>
        m.ok
          ? job.resolve(m.result!)
          : job.reject(new TaskError(m.limit ?? 'error', m.error ?? 'Failed.')),
      );
    };
    const onError = (err: Error & { code?: string }) =>
      kill(
        'crashed',
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? 'Reading it used more memory than allowed.'
          : `The reader stopped unexpectedly: ${err.message}`,
      );
    const onExit = () => {
      if (slot.worker === worker) slot.worker = null;
      finish(() => job.reject(new TaskError('crashed', 'The reader stopped unexpectedly.')));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    const timer =
      job.opts.timeoutMs === null
        ? null
        : setTimeout(
            () =>
              kill(
                'timeout',
                `Reading took longer than ${Math.round(job.opts.timeoutMs! / 1000)} s.`,
              ),
            job.opts.timeoutMs,
          );
    this.running.set(slot, { job, timer });
    worker.postMessage({ id, task: job.task });
  }

  abort(): void {
    for (const j of this.queue.splice(0)) j.reject(new TaskError('cancelled', 'Cancelled.'));
    for (const slot of [...this.running.keys()]) {
      const w = slot.worker;
      const r = this.running.get(slot)!;
      if (r.timer) clearTimeout(r.timer);
      this.running.delete(slot);
      slot.worker = null;
      slot.busy = false;
      if (r.job.opts.large) this.largeRunning = false;
      void w?.terminate();
      r.job.reject(new TaskError('cancelled', 'Cancelled.'));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort();
    await Promise.all(this.slots.map((s) => s.worker?.terminate()));
    for (const s of this.slots) s.worker = null;
  }
}
