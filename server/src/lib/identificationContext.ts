import type { DB } from '../db/database.ts';
import type { EmbeddedMetadata } from '../scan/formats/types.ts';
import { findIsbns } from '../scan/formats/text.ts';
import { HttpError, nowIso, parseJson } from '../util.ts';
import { ensureUserRow } from './progress.ts';

export interface IdentificationContext {
  bundle: string;
  referenceUrl: string;
  title: string;
  author: string;
  isbn: string;
  notes: string;
}

export function validateIdentificationContext(body: unknown): IdentificationContext {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Enter the book’s identification details.');
  const fields = {
    bundle: 200,
    referenceUrl: 2000,
    title: 200,
    author: 100,
    isbn: 30,
    notes: 4000,
  };
  const result = {} as IdentificationContext;
  for (const [key, limit] of Object.entries(fields)) {
    const value = (body as Record<string, unknown>)[key] ?? '';
    if (typeof value !== 'string' || value.length > limit)
      throw new HttpError(400, `${key} must be text of at most ${limit} characters.`);
    result[key as keyof IdentificationContext] = value.trim();
  }
  if (result.referenceUrl) {
    try {
      const url = new URL(result.referenceUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch {
      throw new HttpError(400, 'Use an HTTPS reference link without login details.');
    }
  }
  if (result.isbn) {
    const found = findIsbns(result.isbn);
    if (found.length !== 1 || !/^[\dXx\s-]+$/.test(result.isbn))
      throw new HttpError(400, 'Enter a valid ISBN-10 or ISBN-13.');
    result.isbn = found[0]!;
  }
  return result;
}

export function saveIdentificationContext(db: DB, itemId: string, body: unknown): void {
  const context = validateIdentificationContext(body);
  ensureUserRow(db, itemId);
  db.prepare(
    'UPDATE user_item SET identification_context = ?, updated_at = ? WHERE item_id = ?',
  ).run(Object.values(context).some(Boolean) ? JSON.stringify(context) : null, nowIso(), itemId);
}

/** Cached evidence only: safe for disconnected libraries and cloud placeholders. */
export function identificationContext(db: DB, itemId: string) {
  const saved = db
    .prepare('SELECT identification_context FROM user_item WHERE item_id = ?')
    .pluck()
    .get(itemId) as string | undefined;
  const files = db
    .prepare(
      `SELECT f.name, f.rel_dir, f.metadata FROM files f
    JOIN item_files x ON x.file_id = f.id WHERE x.item_id = ? ORDER BY x.is_primary DESC, f.id`,
    )
    .all(itemId) as { name: string; rel_dir: string; metadata: string | null }[];
  return {
    context: parseJson<IdentificationContext>(saved ?? null, {
      bundle: '',
      referenceUrl: '',
      title: '',
      author: '',
      isbn: '',
      notes: '',
    }),
    files: files.map((f) => {
      const md = parseJson<EmbeddedMetadata>(f.metadata, {});
      return {
        name: f.name,
        folder: f.rel_dir,
        pages: md.openingPages ?? [],
        isbns: [
          ...new Set([
            ...(md.identifiers ?? []).filter((i) => i.scheme === 'isbn').map((i) => i.value),
            ...(md.isbnCandidates ?? []),
          ]),
        ],
      };
    }),
  };
}
