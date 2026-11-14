import fs from 'node:fs';
import path from 'node:path';
import {
  DEEP_FORMATS,
  ESTIMATE_AFTER_FILES,
  EXTERNAL_READ_CONCURRENCY,
  FILE_TIME_LIMIT_MS,
  FULL_HASH_CONCURRENCY,
  LARGE_FILE_BYTES,
} from '../config.ts';
import type { DB } from '../db/database.ts';
import type { Platform } from '../platform/types.ts';
import { nowIso, parseJson } from '../util.ts';
import { joinRel, resolveFolderRoot, type FolderRow } from './folders.ts';
import type { Task } from './formats/index.ts';
import type { MetaResult, Problem } from './formats/types.ts';
import { guardedRead } from './guard.ts';
import type { CancelToken } from './lightPass.ts';
import { TaskError, type TaskRunner } from './pool.ts';

/**
 * The deep pass (PLAN.md §9.2): only files confirmed `present`. Reads metadata (§10), counts
 * words and pages, works out the PDF type, makes a thumbnail and the partial hash — then, last,
 * one at a time, the full hash. Every read goes through the content-read guard (§9.5).
 *
 * Stages are recorded per file with their version, so a stage is skipped only if it completed
 * at the current version: a cancelled or interrupted scan resumes where it stopped, and
 * failures are retried (§9.6). Raise a version when its reader improves.
 */
export const STAGE_VERSIONS = { meta: 3, thumb: 1, full_hash: 1 } as const;
type Stage = keyof typeof STAGE_VERSIONS;

export interface DeepProgress {
  phase: 'reading' | 'hashing' | 'done';
  toRead: number;
  read: number;
  bytesToRead: number;
  bytesRead: number;
  toHash: number;
  hashed: number;
  bytesToHash: number;
  bytesHashed: number;
  /** Files whose read failed this run (listed in Library health). */
  failed: number;
  /** Files the guard refused: found online-only, unknown or changed at the moment of reading. */
  refused: number;
  /** Seconds left in the current phase; null until there is enough progress to mean anything. */
  estimateSeconds: number | null;
}

interface FileRow {
  id: string;
  folder_id: string;
  rel_path: string;
  format: string;
  ext: string;
  size: number;
  modified_ms: number | null;
  stages: string;
  full_hash: string | null;
  has_thumbnail: number;
}

interface Target extends FileRow {
  abs: string;
}

export interface DeepPassOptions {
  db: DB;
  platform: Platform;
  runner: TaskRunner;
  /** Where thumbnails go (data/covers). Null: no thumbnails (tests). */
  coversDir: string | null;
  cancel: CancelToken;
  folderIds: string[];
  onProgress?: (p: DeepProgress) => void;
}

export interface DeepPassResult {
  progress: DeepProgress;
  /** Files whose metadata, hashes or exclusion changed — identity checks look at these. */
  changedFileIds: string[];
}

export const coverPath = (coversDir: string, fileId: string) =>
  path.join(coversDir, `${fileId}.jpg`);

const DEEP = new Set<string>(DEEP_FORMATS);

function needs(f: FileRow, stage: Stage): boolean {
  return parseJson<Record<string, number>>(f.stages, {})[stage] !== STAGE_VERSIONS[stage];
}

function problemFor(err: unknown): { problem: Problem; detail: string } | null {
  const e = err as TaskError;
  const reason = e instanceof TaskError ? e.reason : 'error';
  if (reason === 'cancelled') return null;
  const detail = (e as Error)?.message ?? String(err);
  if (reason === 'timeout') return { problem: 'timeout', detail };
  if (reason === 'too_large') return { problem: 'too_large', detail };
  if (reason === 'encrypted') return { problem: 'encrypted', detail };
  if (['ratio', 'size', 'pixels'].includes(reason) || /memory/.test(detail))
    return { problem: 'limit', detail };
  return { problem: 'corrupt', detail };
}

/** Runs `fn` over `items` with at most `n` in flight, stopping new work once cancelled. */
async function eachLimited<T>(
  items: T[],
  n: number,
  cancel: CancelToken,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (!cancel.cancelled && next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, lane));
}

export async function runDeepPass(o: DeepPassOptions): Promise<DeepPassResult> {
  const { db, platform, runner, coversDir, cancel } = o;
  const changed = new Set<string>();
  const targets: Target[] = [];
  for (const folderId of o.folderIds) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as
      FolderRow | undefined;
    if (!folder) continue;
    const root = await resolveFolderRoot(db, platform, folder);
    if (!root) continue; // unreachable: nothing to read
    const rows = db
      .prepare(
        `SELECT id, folder_id, rel_path, format, ext, size, modified_ms, stages, full_hash, has_thumbnail
         FROM files WHERE folder_id = ? AND availability = 'present' AND stale = 0 AND excluded = 0
         ORDER BY rel_path`,
      )
      .all(folderId) as FileRow[];
    for (const r of rows) targets.push({ ...r, abs: joinRel(root, r.rel_path) });
  }

  if (coversDir) fs.mkdirSync(coversDir, { recursive: true });
  const coverMissing = (f: Target) =>
    coversDir !== null && f.has_thumbnail === 1 && !fs.existsSync(coverPath(coversDir, f.id));
  const toRead = targets.filter(
    (f) =>
      DEEP.has(f.format) &&
      (needs(f, 'meta') || (coversDir !== null && (needs(f, 'thumb') || coverMissing(f)))),
  );
  const toHash = targets.filter((f) => needs(f, 'full_hash') || !f.full_hash);

  const progress: DeepProgress = {
    phase: 'reading',
    toRead: toRead.length,
    read: 0,
    bytesToRead: toRead.reduce((n, f) => n + f.size, 0),
    bytesRead: 0,
    toHash: toHash.length,
    hashed: 0,
    bytesToHash: toHash.reduce((n, f) => n + f.size, 0),
    bytesHashed: 0,
    failed: 0,
    refused: 0,
    estimateSeconds: null,
  };
  let phaseStart = Date.now();
  const report = () => {
    const elapsed = (Date.now() - phaseStart) / 1000;
    if (progress.phase === 'reading') {
      progress.estimateSeconds =
        // By bytes, not files: reading is mostly disk time, and a library can hold 1 MB books
        // and 300 MB comics. Counting files misjudged the owner's first scan badly.
        progress.read >= ESTIMATE_AFTER_FILES && progress.bytesRead > 0
          ? Math.round((elapsed / progress.bytesRead) * (progress.bytesToRead - progress.bytesRead))
          : null;
    } else if (progress.phase === 'hashing') {
      progress.estimateSeconds =
        progress.hashed >= ESTIMATE_AFTER_FILES && progress.bytesHashed > 0
          ? Math.round(
              (elapsed / progress.bytesHashed) * (progress.bytesToHash - progress.bytesHashed),
            )
          : null;
    } else progress.estimateSeconds = null;
    o.onProgress?.({ ...progress });
  };

  const markStage = db.prepare(
    `UPDATE files SET stages = json_set(CASE WHEN json_valid(stages) THEN stages ELSE '{}' END, '$.' || ?, ?) WHERE id = ?`,
  );
  const recordProblem = (id: string, err: unknown) => {
    const p = problemFor(err);
    if (!p) return;
    progress.failed++;
    db.prepare('UPDATE files SET problem = ?, problem_detail = ?, problem_at = ? WHERE id = ?').run(
      p.problem,
      p.detail.slice(0, 500),
      nowIso(),
      id,
    );
    changed.add(id);
  };
  const timeLimit = (f: Target) => ({
    timeoutMs: FILE_TIME_LIMIT_MS,
    large: f.size >= LARGE_FILE_BYTES,
  });

  // ---- Reading: details, counts, PDF type, partial hash and the cover, in one read per file. --
  const saveCover = (id: string, jpeg: Uint8Array | null) => {
    if (!coversDir) return;
    if (jpeg) fs.writeFileSync(coverPath(coversDir, id), jpeg);
    db.prepare('UPDATE files SET has_thumbnail = ? WHERE id = ?').run(jpeg ? 1 : 0, id);
    markStage.run('thumb', STAGE_VERSIONS.thumb, id);
  };
  const saveFullHash = (id: string, hash: string) => {
    db.prepare('UPDATE files SET full_hash = ? WHERE id = ?').run(hash, id);
    markStage.run('full_hash', STAGE_VERSIONS.full_hash, id);
    hashedEarly.add(id);
  };
  const hashedEarly = new Set<string>();
  const wantsCover = (f: Target) => coversDir !== null && (needs(f, 'thumb') || coverMissing(f));

  const readOne = async (f: Target) => {
    try {
      if (needs(f, 'meta')) {
        // One guard check, then one read for details and cover (§9.5: the check comes
        // immediately before the read it authorises).
        const task: Task = {
          kind: 'read',
          file: f.abs,
          format: f.format,
          ext: f.ext,
          wantCover: wantsCover(f),
        };
        const out = await guardedRead(db, platform, runner, f, task, timeLimit(f));
        if (!out.ok) progress.refused++;
        else if (out.result.kind === 'read') {
          const r = out.result;
          writeMeta(db, f.id, r.meta, r.partialHash);
          markStage.run('meta', STAGE_VERSIONS.meta, f.id);
          changed.add(f.id);
          if (r.jpeg !== undefined && !r.meta.notComic) saveCover(f.id, r.jpeg);
          if (r.fullHash) saveFullHash(f.id, r.fullHash);
        }
      } else if (wantsCover(f)) {
        // Details are known; only the cover is missing (e.g. after a restore).
        const out = await guardedRead(
          db,
          platform,
          runner,
          f,
          { kind: 'thumb', file: f.abs, format: f.format },
          timeLimit(f),
        );
        if (!out.ok) progress.refused++;
        else if (out.result.kind === 'thumb') saveCover(f.id, out.result.jpeg);
      }
    } catch (err) {
      recordProblem(f.id, err);
    }
    progress.read++;
    progress.bytesRead += f.size;
    report();
  };

  report();
  // External drives one file at a time (they seek); other folders use the whole pool.
  const external = new Set(
    db.prepare("SELECT id FROM folders WHERE storage_kind = 'external'").pluck().all() as string[],
  );
  await eachLimited(
    toRead.filter((f) => external.has(f.folder_id)),
    Math.min(runner.size, EXTERNAL_READ_CONCURRENCY),
    cancel,
    readOne,
  );
  await eachLimited(
    toRead.filter((f) => !external.has(f.folder_id)),
    runner.size,
    cancel,
    readOne,
  );

  // ---- Full hashes: last, one file at a time, no time limit but cancellable (§20). -------------
  if (!cancel.cancelled) {
    progress.phase = 'hashing';
    phaseStart = Date.now();
    report();
    // Files excluded by the reading phase (not comics) are skipped now.
    const stillIn = db.prepare('SELECT excluded FROM files WHERE id = ?').pluck();
    await eachLimited(toHash, FULL_HASH_CONCURRENCY, cancel, async (f) => {
      if (stillIn.get(f.id) === 1) return;
      if (hashedEarly.has(f.id)) {
        // Fingerprinted from the reading pass's own read (RAR): nothing more to read.
        progress.hashed++;
        progress.bytesHashed += f.size;
        return;
      }
      try {
        const out = await guardedRead(
          db,
          platform,
          runner,
          f,
          { kind: 'full_hash', file: f.abs },
          { timeoutMs: null },
        );
        if (!out.ok) progress.refused++;
        else if (out.result.kind === 'full_hash') {
          db.prepare('UPDATE files SET full_hash = ?, partial_hash = ? WHERE id = ?').run(
            out.result.hash,
            out.result.partialHash,
            f.id,
          );
          markStage.run('full_hash', STAGE_VERSIONS.full_hash, f.id);
          changed.add(f.id);
        }
      } catch (err) {
        recordProblem(f.id, err);
      }
      progress.hashed++;
      progress.bytesHashed += f.size;
      report();
    });
  }
  if (!cancel.cancelled) progress.phase = 'done';
  report();
  return { progress, changedFileIds: [...changed] };
}

function writeMeta(db: DB, fileId: string, m: MetaResult, partialHash: string): void {
  if (m.notComic) {
    // An archive that isn't a comic (§9.1): dropped from the library, listed in Library health.
    db.prepare(
      `UPDATE files SET excluded = 1, problem = 'not_comic', problem_detail = ?, problem_at = ?,
         partial_hash = ? WHERE id = ?`,
    ).run(m.notComic, nowIso(), partialHash, fileId);
    return;
  }
  db.prepare(
    `UPDATE files SET metadata = ?, word_count = ?, page_count = ?, language = ?,
       pdf_type = ?, pdf_type_evidence = ?, partial_hash = ?,
       problem = NULL, problem_detail = NULL, problem_at = NULL
     WHERE id = ?`,
  ).run(
    JSON.stringify(m.metadata),
    m.wordCount,
    m.pageCount,
    normaliseLanguage(m.metadata.language),
    m.pdfType?.type ?? null,
    m.pdfType?.evidence ?? null,
    partialHash,
    fileId,
  );
  // Opening text lives in its own table: lookups parse `metadata` often and don't need it.
  if (m.openingPages?.length)
    db.prepare(
      `INSERT INTO file_opening_text (file_id, pages) VALUES (?, ?)
       ON CONFLICT (file_id) DO UPDATE SET pages = excluded.pages`,
    ).run(fileId, JSON.stringify(m.openingPages));
  else db.prepare('DELETE FROM file_opening_text WHERE file_id = ?').run(fileId);
}

/**
 * Language as its primary subtag ("en-GB" → "en", "eng" → "en" for the common three-letter
 * codes), so two copies tagged "en" and "en-US" don't look like a language conflict (§11.3).
 */
export function normaliseLanguage(lang: string | undefined): string | null {
  if (!lang) return null;
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0]!;
  const three: Record<string, string> = {
    eng: 'en',
    fre: 'fr',
    fra: 'fr',
    ger: 'de',
    deu: 'de',
    spa: 'es',
    ita: 'it',
    jpn: 'ja',
    por: 'pt',
    rus: 'ru',
    chi: 'zh',
    zho: 'zh',
    kor: 'ko',
    dut: 'nl',
    nld: 'nl',
  };
  const code = three[primary] ?? primary;
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}
