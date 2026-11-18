import type { DB } from '../db/database.ts';

/**
 * How the audiobook folders were read, as counts only (never a name): the owner wasn't sure
 * whether their audiobooks are one file each or folders of parts, so Diagnostics says what the
 * scan found, and the copied report can be shared (docs/plans/audiobooks.md).
 */
export interface AudiobookDiagnostics {
  /** Directories marked as holding audiobooks, over all library folders. */
  folders: number;
  files: number;
  /** Audio files by type, e.g. { mp3: 412, m4b: 30 }. */
  byType: Record<string, number>;
  /** Books the files were read as (the same book copied to two places counts twice here). */
  books: number;
  oneFileBooks: number;
  manyFileBooks: number;
  /** The most files in one book. */
  largestBook: number;
  /** Files read whose playing time isn't known (unreadable, or a type that can't be read). */
  noPlayingTime: number;
  /** Files not read yet (drive not connected, or the scan hasn't reached them). */
  notReadYet: number;
}

export function audiobookDiagnostics(db: DB): AudiobookDiagnostics {
  const folders = (
    db.prepare('SELECT audiobook_dirs FROM folders').pluck().all() as string[]
  ).reduce((n, j) => {
    try {
      const v = JSON.parse(j) as unknown;
      return n + (Array.isArray(v) ? v.length : 0);
    } catch {
      return n;
    }
  }, 0);
  const byType = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT ext, COUNT(*) AS n FROM files WHERE format = 'audio' AND excluded = 0 GROUP BY ext ORDER BY ext",
        )
        .all() as { ext: string; n: number }[]
    ).map((r) => [r.ext, r.n]),
  );
  const books = db
    .prepare(
      `SELECT COUNT(*) AS n FROM files WHERE format = 'audio' AND excluded = 0
       GROUP BY folder_id, book_dir, compare_key`,
    )
    .pluck()
    .all() as number[];
  const count = (where: string) =>
    db
      .prepare(`SELECT COUNT(*) FROM files WHERE format = 'audio' AND excluded = 0 AND ${where}`)
      .pluck()
      .get() as number;
  return {
    folders,
    files: books.reduce((a, b) => a + b, 0),
    byType,
    books: books.length,
    oneFileBooks: books.filter((n) => n === 1).length,
    manyFileBooks: books.filter((n) => n > 1).length,
    largestBook: books.reduce((a, b) => Math.max(a, b), 0),
    noPlayingTime: count("duration_seconds IS NULL AND json_extract(stages, '$.meta') IS NOT NULL"),
    notReadYet: count("json_extract(stages, '$.meta') IS NULL"),
  };
}
