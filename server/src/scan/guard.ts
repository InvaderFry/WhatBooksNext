import fs from 'node:fs';
import type { DB } from '../db/database.ts';
import { availabilityFromAttributes, type Platform } from '../platform/types.ts';
import type { Task, TaskResult } from './formats/index.ts';
import type { RunOptions, TaskRunner } from './pool.ts';

/**
 * The single guard in front of every content reader (PLAN.md §9.5): metadata, thumbnails and
 * hashing all go through `guardedRead`, and nothing else hands work to the pool.
 *
 * Immediately before each read it asks the platform for the file's attributes again — the
 * light pass's batch listing never authorises a read. Placeholder or unknown → no read, and the
 * file's availability is updated. The gap between this check and the read is milliseconds; we
 * accept it (README, "Limitations").
 */

export interface GuardTarget {
  id: string;
  abs: string;
  size: number;
  modified_ms: number | null;
}

export type GuardOutcome =
  | { ok: true; result: TaskResult }
  | { ok: false; refused: 'placeholder' | 'unknown' | 'changed' | 'gone' };

export async function guardedRead(
  db: DB,
  platform: Platform,
  runner: TaskRunner,
  file: GuardTarget,
  task: Task,
  opts: RunOptions,
): Promise<GuardOutcome> {
  if (platform.supportsPlaceholders) {
    const attrs = await platform.checkAttributes(file.abs);
    const state = availabilityFromAttributes(attrs);
    if (state !== 'present') {
      db.prepare('UPDATE files SET availability = ?, attributes = ? WHERE id = ?').run(
        state,
        attrs,
        file.id,
      );
      return { ok: false, refused: state };
    }
  }
  // stat reads directory metadata only; it never recalls a cloud file.
  let st: fs.Stats;
  try {
    st = fs.statSync(file.abs);
  } catch {
    return { ok: false, refused: 'gone' };
  }
  // Changed since the light pass listed it: the next scan sees the new version first.
  if (st.size !== file.size) return { ok: false, refused: 'changed' };
  return { ok: true, result: await runner.run(task, opts) };
}
