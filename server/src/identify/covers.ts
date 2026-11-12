import fs from 'node:fs';
import path from 'node:path';
import { COVER_MAX_BYTES, COVER_RETRY_DAYS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { thumbnailFromImage } from '../scan/formats/thumbnail.ts';
import type { Sources } from '../sources/index.ts';
import { SourceError } from '../sources/types.ts';
import { nowIso } from '../util.ts';

/**
 * Covers for books without a file cover (store books, reading history), from Open Library (owner
 * decision 2026-11-11). Only for a book matched with confidence: the owner confirmed an Open
 * Library match, or the app accepted one on its own. A provisional or rejected match never gets a
 * cover: a wrong picture would be worse than none. Unknown stays unknown.
 *
 * Per book: the work record (`/works/OL…W.json`, cached like every Open Library answer) for its
 * cover IDs, then the first cover by ID (`covers.openlibrary.org/b/id/<id>-M.jpg`), both through
 * the Open Library client, so they share its pace (1 a second), its pause after failures and its
 * User-Agent. The picture is scaled like a file cover and kept as covers/item-<id>.jpg.
 */

export const itemCoverPath = (coversDir: string, itemId: string) =>
  path.join(coversDir, `item-${itemId}.jpg`);

const WORK_KEY = /^\/works\/OL\d+W$/;

/** Books that could get a cover now: no file cover, a confident Open Library match, not asked lately. */
export function coverCandidates(db: DB, now = new Date()): { itemId: string; work: string }[] {
  const retryBefore = new Date(now.getTime() - COVER_RETRY_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT i.id, u.match_override, ls.accepted_source_id FROM items i
       LEFT JOIN user_item u ON u.item_id = i.id
       LEFT JOIN lookup_state ls ON ls.item_id = i.id AND ls.source = 'openlibrary'
       WHERE NOT EXISTS (SELECT 1 FROM item_files x JOIN files f ON f.id = x.file_id
                         WHERE x.item_id = i.id AND f.has_thumbnail = 1)
         AND NOT EXISTS (SELECT 1 FROM item_covers c WHERE c.item_id = i.id
                         AND (c.state = 'ok' OR c.checked_at > ?))
       ORDER BY i.created_at, i.id`,
    )
    .all(retryBefore) as {
    id: string;
    match_override: string | null;
    accepted_source_id: string | null;
  }[];
  const out: { itemId: string; work: string }[] = [];
  for (const r of rows) {
    // The owner's own choice wins; one that isn't Open Library means no Open Library cover.
    const work = r.match_override
      ? r.match_override.startsWith('openlibrary:')
        ? r.match_override.slice('openlibrary:'.length)
        : null
      : r.accepted_source_id;
    if (!work || !WORK_KEY.test(work)) continue;
    // A match the owner rejected is never used.
    if (
      db
        .prepare(
          "SELECT 1 FROM candidates_rejected WHERE item_id = ? AND source = 'openlibrary' AND source_id = ?",
        )
        .get(r.id, work)
    )
      continue;
    out.push({ itemId: r.id, work });
  }
  return out;
}

export class CoverFetcher {
  private readonly db: DB;
  private readonly sources: Sources;
  private readonly coversDir: string | null;
  private running: Promise<void> | null = null;
  private stop = false;

  constructor(db: DB, sources: Sources, coversDir: string | null) {
    this.db = db;
    this.sources = sources;
    this.coversDir = coversDir;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts a run unless one is going; it ends by itself when nothing is left. */
  start(): void {
    if (this.running || !this.coversDir) return;
    this.stop = false;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  async wait(): Promise<void> {
    await this.running;
  }

  async close(): Promise<void> {
    this.stop = true;
    await this.running;
  }

  private record(
    itemId: string,
    state: 'ok' | 'none' | 'failed',
    work: string,
    coverId: string | null,
  ) {
    this.db
      .prepare(
        `INSERT INTO item_covers (item_id, state, source, source_ref, cover_id, checked_at)
         VALUES (?, ?, 'openlibrary', ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET state = excluded.state, source_ref = excluded.source_ref,
           cover_id = excluded.cover_id, checked_at = excluded.checked_at`,
      )
      .run(itemId, state, work, coverId, nowIso());
  }

  private async run(): Promise<void> {
    const dir = this.coversDir!;
    fs.mkdirSync(dir, { recursive: true });
    const client = this.sources.openlibrary.client;
    for (const { itemId, work } of coverCandidates(this.db)) {
      if (this.stop) return;
      // Merged away or removed since the list was made.
      if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) continue;
      try {
        const rec = (await client.json(
          `https://openlibrary.org${work}.json`,
          {},
          `work:${work}`,
        )) as {
          covers?: unknown;
        } | null;
        const ids = Array.isArray(rec?.covers)
          ? rec!.covers.filter((x): x is number => Number.isInteger(x) && (x as number) > 0)
          : [];
        if (ids.length === 0) {
          this.record(itemId, 'none', work, null);
          continue;
        }
        const coverId = String(ids[0]);
        const bytes = await client.image(
          `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`,
          COVER_MAX_BYTES,
        );
        if (!bytes) {
          this.record(itemId, 'none', work, coverId);
          continue;
        }
        let jpeg: Buffer;
        try {
          jpeg = await thumbnailFromImage(bytes);
        } catch {
          this.record(itemId, 'failed', work, coverId);
          continue;
        }
        fs.writeFileSync(itemCoverPath(dir, itemId), jpeg);
        this.record(itemId, 'ok', work, coverId);
      } catch (e) {
        // Offline, paused or out of allowance: stop here and try the rest next time.
        if (e instanceof SourceError && e.transient) return;
        this.record(itemId, 'failed', work, null);
      }
    }
  }
}
