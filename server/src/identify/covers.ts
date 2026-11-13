import fs from 'node:fs';
import path from 'node:path';
import { COVER_MAX_BYTES, COVER_RETRY_DAYS } from '../config.ts';
import type { DB } from '../db/database.ts';
import { thumbnailFromImage } from '../scan/formats/thumbnail.ts';
import { sourceCoverUrl } from '../sources/covers.ts';
import type { Sources } from '../sources/index.ts';
import { SourceError, type SourceName } from '../sources/types.ts';
import { nowIso, parseJson } from '../util.ts';

/**
 * Covers for books without a file cover (store books, reading history), from the book's own
 * confident match on any source (owner decisions 2026-11-11 and 2026-11-13). Only for a match the
 * owner confirmed or the app accepted on its own: a provisional, tied or rejected match never gets
 * a cover, because a wrong picture would be worse than none. Unknown stays unknown.
 *
 * Which match: the owner's confirmed one, and only that one. Otherwise the book's main match, then
 * the other sources' accepted matches, in turn, until one gives a picture.
 *
 * Open Library: the work record (`/works/OL…W.json`, cached like every Open Library answer) for its
 * cover IDs, then the first cover by ID (`covers.openlibrary.org/b/id/<id>-M.jpg`). Other sources
 * (Hardcover, Metron, ComicVine, AniList): the cover address stored with the match, only on the
 * source's own image hosts (`COVER_HOSTS`). Every picture goes through its source's client, so it
 * shares that source's pace, its pause after failures and its User-Agent, and never carries an API
 * key. The picture is scaled like a file cover and kept as covers/item-<id>.jpg.
 */

export const itemCoverPath = (coversDir: string, itemId: string) =>
  path.join(coversDir, `item-${itemId}.jpg`);

const WORK_KEY = /^\/works\/OL\d+W$/;

/** One place a book's cover could come from: an Open Library work, or a stored cover address. */
export interface CoverPlan {
  source: SourceName;
  /** The source's record the cover belongs to (an Open Library work key, a Hardcover id…). */
  ref: string;
  /** For sources other than Open Library: the cover address stored with the match. */
  url?: string;
}

const key = (source: string, ref: string) => `${source}:${ref}`;

function splitKey(k: string): { source: string; ref: string } | null {
  const at = k.indexOf(':');
  return at > 0 ? { source: k.slice(0, at), ref: k.slice(at + 1) } : null;
}

/**
 * Per book without a file cover: where its cover could come from, in order. Empty when it has no
 * confident match (none at all, only provisional or tied ones, or "leave unidentified").
 */
function plansByItem(db: DB): Map<string, CoverPlan[]> {
  const items = db
    .prepare(
      `SELECT i.id, i.identity, i.match_source, i.match_source_id, u.match_override FROM items i
       LEFT JOIN user_item u ON u.item_id = i.id
       WHERE NOT EXISTS (SELECT 1 FROM item_files x JOIN files f ON f.id = x.file_id
                         WHERE x.item_id = i.id AND f.has_thumbnail = 1)
       ORDER BY i.created_at, i.id`,
    )
    .all() as {
    id: string;
    identity: string;
    match_source: string | null;
    match_source_id: string | null;
    match_override: string | null;
  }[];
  const accepted = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `SELECT item_id, source, accepted_source_id FROM lookup_state
       WHERE accepted_source_id IS NOT NULL ORDER BY item_id, source`,
    )
    .all() as { item_id: string; source: string; accepted_source_id: string }[]) {
    if (!accepted.has(r.item_id)) accepted.set(r.item_id, []);
    accepted.get(r.item_id)!.push(key(r.source, r.accepted_source_id));
  }
  const rejected = new Set(
    (
      db.prepare('SELECT item_id, source, source_id FROM candidates_rejected').all() as {
        item_id: string;
        source: string;
        source_id: string;
      }[]
    ).map((r) => `${r.item_id}|${key(r.source, r.source_id)}`),
  );
  const coverOf = db.prepare(
    'SELECT data FROM item_matches WHERE item_id = ? AND source = ? AND source_id = ?',
  );

  const out = new Map<string, CoverPlan[]>();
  for (const i of items) {
    if (i.match_override === 'none') {
      out.set(i.id, []);
      continue;
    }
    // The owner's own choice wins, alone: another source's guess never stands in for it.
    const keys = i.match_override
      ? [i.match_override]
      : [
          ...(i.identity === 'accepted' && i.match_source && i.match_source_id
            ? [key(i.match_source, i.match_source_id)]
            : []),
          ...(accepted.get(i.id) ?? []),
        ];
    const plans: CoverPlan[] = [];
    for (const k of new Set(keys)) {
      // A match the owner rejected is never used.
      if (rejected.has(`${i.id}|${k}`)) continue;
      const m = splitKey(k);
      if (!m) continue;
      if (m.source === 'openlibrary') {
        if (WORK_KEY.test(m.ref)) plans.push({ source: 'openlibrary', ref: m.ref });
        continue;
      }
      const row = coverOf.get(i.id, m.source, m.ref) as { data: string } | undefined;
      const url = sourceCoverUrl(
        m.source as SourceName,
        parseJson<{ coverUrl?: unknown }>(row?.data, {}).coverUrl,
      );
      if (url) plans.push({ source: m.source as SourceName, ref: m.ref, url });
    }
    out.set(i.id, plans);
  }
  return out;
}

/**
 * Books that could get a cover now: no file cover, a confident match with a cover to ask for, and
 * not asked lately. A book whose saved cover belongs to a match it no longer has is asked again.
 */
export function coverCandidates(
  db: DB,
  now = new Date(),
): { itemId: string; plans: CoverPlan[] }[] {
  const retryBefore = new Date(now.getTime() - COVER_RETRY_DAYS * 86_400_000).toISOString();
  const saved = new Map(
    (
      db
        .prepare('SELECT item_id, state, source, source_ref, checked_at FROM item_covers')
        .all() as {
        item_id: string;
        state: string;
        source: string;
        source_ref: string;
        checked_at: string;
      }[]
    ).map((r) => [r.item_id, r]),
  );
  const out: { itemId: string; plans: CoverPlan[] }[] = [];
  for (const [itemId, plans] of plansByItem(db)) {
    if (plans.length === 0) continue;
    const s = saved.get(itemId);
    const stillFits = s && plans.some((p) => p.source === s.source && p.ref === s.source_ref);
    if (stillFits && (s.state === 'ok' || s.checked_at > retryBefore)) continue;
    out.push({ itemId, plans });
  }
  return out;
}

/** Saved covers whose book no longer has any confident match: they stop showing. */
export function staleCovers(db: DB): string[] {
  const plans = plansByItem(db);
  return (db.prepare('SELECT item_id FROM item_covers').pluck().all() as string[]).filter(
    (id) => plans.has(id) && plans.get(id)!.length === 0,
  );
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
    plan: CoverPlan,
    coverId: string | null,
  ) {
    this.db
      .prepare(
        `INSERT INTO item_covers (item_id, state, source, source_ref, cover_id, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET state = excluded.state, source = excluded.source,
           source_ref = excluded.source_ref, cover_id = excluded.cover_id,
           checked_at = excluded.checked_at`,
      )
      .run(itemId, state, plan.source, plan.ref, coverId, nowIso());
  }

  private client(source: SourceName) {
    const s = (this.sources as unknown as Record<string, { client?: unknown } | undefined>)[source];
    return (s?.client ?? null) as Sources['openlibrary']['client'] | null;
  }

  /** One plan's picture: the bytes, or why there are none. Transient errors are thrown. */
  private async fetchPlan(
    plan: CoverPlan,
  ): Promise<{ bytes: Uint8Array | null; coverId: string | null }> {
    const client = this.client(plan.source);
    if (!client) return { bytes: null, coverId: null };
    if (plan.source !== 'openlibrary')
      return { bytes: await client.image(plan.url!, COVER_MAX_BYTES), coverId: null };
    const rec = (await client.json(
      `https://openlibrary.org${plan.ref}.json`,
      {},
      `work:${plan.ref}`,
    )) as { covers?: unknown } | null;
    const ids = Array.isArray(rec?.covers)
      ? rec!.covers.filter((x): x is number => Number.isInteger(x) && (x as number) > 0)
      : [];
    if (ids.length === 0) return { bytes: null, coverId: null };
    const coverId = String(ids[0]);
    return {
      bytes: await client.image(
        `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`,
        COVER_MAX_BYTES,
      ),
      coverId,
    };
  }

  private async run(): Promise<void> {
    const dir = this.coversDir!;
    fs.mkdirSync(dir, { recursive: true });
    for (const itemId of staleCovers(this.db)) {
      this.db.prepare('DELETE FROM item_covers WHERE item_id = ?').run(itemId);
      fs.rmSync(itemCoverPath(dir, itemId), { force: true });
    }
    // Sources that are offline, paused or out of allowance in this run: their books wait.
    const down = new Set<SourceName>();
    items: for (const { itemId, plans } of coverCandidates(this.db)) {
      if (this.stop) return;
      // Merged away or removed since the list was made.
      if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) continue;
      // Each match in turn, until one gives a picture; otherwise the first one's answer is kept.
      let first: { state: 'none' | 'failed'; plan: CoverPlan; coverId: string | null } | null =
        null;
      let saved = false;
      for (const plan of plans) {
        if (down.has(plan.source)) continue items;
        let state: 'none' | 'failed';
        let coverId: string | null = null;
        try {
          const got = await this.fetchPlan(plan);
          coverId = got.coverId;
          if (got.bytes) {
            let jpeg: Buffer | null = null;
            try {
              jpeg = await thumbnailFromImage(got.bytes);
            } catch {
              jpeg = null;
            }
            if (jpeg) {
              fs.writeFileSync(itemCoverPath(dir, itemId), jpeg);
              this.record(itemId, 'ok', plan, coverId);
              saved = true;
              break;
            }
            state = 'failed';
          } else state = 'none';
        } catch (e) {
          // Offline, paused or out of allowance: record nothing, so the next run tries again.
          if (e instanceof SourceError && e.transient) {
            down.add(plan.source);
            continue items;
          }
          state = 'failed';
        }
        first ??= { state, plan, coverId };
      }
      if (!saved && first) {
        this.record(itemId, first.state, first.plan, first.coverId);
        // A picture from a match the book no longer has must not stay behind.
        fs.rmSync(itemCoverPath(dir, itemId), { force: true });
      }
    }
  }
}
