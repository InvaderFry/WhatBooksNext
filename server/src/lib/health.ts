import type { DB } from '../db/database.ts';

/**
 * Library health (PLAN.md §15): files that couldn't be read, kept apart from things that are
 * merely incomplete (no text layer, uncertain type) and from information (copies, ignored
 * formats). Names are shown: this page is on the owner's own PC.
 */

export interface HealthFile {
  fileId: string;
  itemId: string | null;
  name: string;
  folderPath: string;
  relPath: string;
  format: string;
  size: number;
  problem: string | null;
  detail: string | null;
  at: string | null;
}

export interface Health {
  errors: HealthFile[];
  notComics: HealthFile[];
  noTextLayer: HealthFile[];
  uncertainPdfs: number;
  /** Items with files in more than one folder (informational: copies are fine). */
  itemsWithCopies: number;
  filesInCopies: number;
  notYetRead: number;
  notYetHashed: number;
  ignoredByType: Record<string, number>;
}

const SELECT = `SELECT f.id AS fileId, x.item_id AS itemId, f.name, d.display_path AS folderPath,
  f.rel_path AS relPath, f.format, f.size, f.problem, f.problem_detail AS detail, f.problem_at AS at
  FROM files f JOIN folders d ON d.id = f.folder_id LEFT JOIN item_files x ON x.file_id = f.id`;

export function libraryHealth(db: DB): Health {
  const errors = db
    .prepare(
      `${SELECT} WHERE f.problem IS NOT NULL AND f.problem != 'not_comic' AND f.availability != 'missing' ORDER BY f.problem, f.name`,
    )
    .all() as HealthFile[];
  const notComics = db
    .prepare(
      `${SELECT} WHERE f.problem = 'not_comic' AND f.availability != 'missing' ORDER BY f.name`,
    )
    .all() as HealthFile[];
  // Page images with no words: a scan without OCR, or a comic we couldn't recognise as one.
  const noTextLayer = db
    .prepare(
      `${SELECT} LEFT JOIN file_user u ON u.file_id = f.id
       WHERE f.format = 'pdf' AND f.word_count IS NULL AND f.pdf_type IS NOT NULL
         AND COALESCE(u.pdf_type_override, f.pdf_type) != 'comic' AND f.availability != 'missing'
       ORDER BY f.name`,
    )
    .all() as HealthFile[];
  const copies = db
    .prepare(
      `SELECT COUNT(*) AS items, COALESCE(SUM(n), 0) AS files FROM (
         SELECT x.item_id, COUNT(*) AS n, COUNT(DISTINCT f.folder_id || '/' || f.rel_dir) AS dirs
         FROM item_files x JOIN files f ON f.id = x.file_id GROUP BY x.item_id) WHERE dirs > 1`,
    )
    .get() as { items: number; files: number };
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  const ignoredByType: Record<string, number> = {};
  const last = db
    .prepare(
      "SELECT summary FROM scan_runs WHERE kind = 'light' AND status != 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .pluck()
    .get() as string | undefined;
  if (last) {
    try {
      for (const f of (JSON.parse(last) as { folders: { ignoredByType: Record<string, number> }[] })
        .folders)
        for (const [k, v] of Object.entries(f.ignoredByType ?? {}))
          ignoredByType[k] = (ignoredByType[k] ?? 0) + v;
    } catch {
      // an unreadable old summary just means no counts
    }
  }
  return {
    errors,
    notComics,
    noTextLayer,
    uncertainPdfs: count("SELECT COUNT(*) FROM files WHERE pdf_type = 'uncertain'"),
    itemsWithCopies: copies.items,
    filesInCopies: copies.files,
    notYetRead: count(
      `SELECT COUNT(*) FROM files WHERE availability = 'present' AND excluded = 0 AND problem IS NULL
       AND format IN ('epub', 'pdf', 'cbz', 'cbr') AND json_extract(stages, '$.meta') IS NULL`,
    ),
    notYetHashed: count(
      "SELECT COUNT(*) FROM files WHERE availability = 'present' AND excluded = 0 AND full_hash IS NULL",
    ),
    ignoredByType,
  };
}

export function healthProblemCount(db: DB): number {
  return db
    .prepare("SELECT COUNT(*) FROM files WHERE problem IS NOT NULL AND availability != 'missing'")
    .pluck()
    .get() as number;
}
