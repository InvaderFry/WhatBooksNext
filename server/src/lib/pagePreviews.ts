import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { FILE_TIME_LIMIT_MS, LARGE_FILE_BYTES } from '../config.ts';
import type { DB } from '../db/database.ts';
import type { Platform } from '../platform/types.ts';
import { joinRel, resolveFolderRoot, type FolderRow } from '../scan/folders.ts';
import { guardedRead } from '../scan/guard.ts';
import { TaskError, WorkerPool, type TaskRunner } from '../scan/pool.ts';
import { HttpError, parseJson } from '../util.ts';
import { route } from '../routes/route.ts';

const SUPPORTED = new Set(['pdf', 'epub', 'cbz', 'cbr']);
const PREVIEW_VERSION = 1;
interface FileRow {
  id: string;
  name: string;
  format: string;
  availability: string;
  stale: number;
  folder_id: string;
  rel_path: string;
  size: number;
  modified_ms: number | null;
  full_hash: string | null;
}
interface Manifest {
  stamp: string;
  count: number;
}
export interface PagePreviewFile {
  id: string;
  name: string;
  format: string;
  availability: string;
  supported: boolean;
  pages: { label: string; url: string }[];
  note: string | null;
}

/** On-demand, disposable images. GET serves the cache only; POST is the only content reader. */
export class PagePreviews {
  private runner: TaskRunner | null;
  private pending = new Map<string, Promise<PagePreviewFile>>();
  private readonly dir: string | null;
  private readonly db: DB;
  private readonly platform: Platform;
  constructor(db: DB, platform: Platform, dataDir: string | null, runner?: TaskRunner) {
    this.db = db;
    this.platform = platform;
    this.dir = dataDir ? path.join(dataDir, 'page-previews') : null;
    this.runner = runner ?? null;
    this.ownsRunner = !runner;
  }
  private readonly ownsRunner: boolean;
  private file(id: string): FileRow {
    const file = this.db.prepare('SELECT * FROM files WHERE id = ? AND excluded = 0').get(id) as
      FileRow | undefined;
    if (!file) throw new HttpError(404, 'No such file.');
    return file;
  }
  private stamp(file: FileRow): string {
    return createHash('sha256')
      .update(JSON.stringify([PREVIEW_VERSION, file.size, file.modified_ms, file.full_hash]))
      .digest('hex');
  }
  private directory(file: FileRow): string {
    if (!this.dir) throw new HttpError(409, 'Preview storage is unavailable.');
    return path.join(this.dir, file.id);
  }
  private manifest(file: FileRow): Manifest | null {
    if (!this.dir || file.stale) return null;
    try {
      const manifest = parseJson<Manifest | null>(
        fs.readFileSync(path.join(this.directory(file), 'manifest.json'), 'utf8'),
        null,
      );
      if (
        !manifest ||
        manifest.stamp !== this.stamp(file) ||
        !Number.isInteger(manifest.count) ||
        manifest.count < 0 ||
        manifest.count > 2
      )
        return null;
      for (let n = 1; n <= manifest.count; n++)
        if (!fs.existsSync(path.join(this.directory(file), `${n}.jpg`))) return null;
      return manifest;
    } catch {
      return null;
    }
  }
  status(id: string): PagePreviewFile {
    const file = this.file(id);
    const manifest = this.manifest(file);
    const epub = file.format === 'epub';
    return {
      id: file.id,
      name: file.name,
      format: file.format,
      availability: file.availability,
      supported: SUPPORTED.has(file.format),
      pages: Array.from({ length: manifest?.count ?? 0 }, (_, n) => ({
        label: epub ? `Opening section ${n + 1}` : `Page ${n + 1}`,
        url: `/api/files/${encodeURIComponent(file.id)}/page-previews/${n + 1}?v=${manifest!.stamp}`,
      })),
      note: !SUPPORTED.has(file.format)
        ? 'Page previews are not supported for this file format.'
        : file.stale
          ? 'This file changed. Scan its folder before generating previews.'
          : manifest?.count === 0
            ? 'No opening pages could be previewed.'
            : epub
              ? 'EPUBs reflow: these are the first two opening sections, with simplified text layout, not fixed page numbers.'
              : null,
    };
  }
  forItem(id: string): PagePreviewFile[] {
    if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(id))
      throw new HttpError(404, 'No such book.');
    return (
      this.db
        .prepare(
          `SELECT f.id FROM files f JOIN item_files x ON x.file_id = f.id
      WHERE x.item_id = ? AND f.excluded = 0 ORDER BY x.is_primary DESC, f.name`,
        )
        .all(id) as { id: string }[]
    ).map((f) => this.status(f.id));
  }
  image(id: string, page: number): string {
    const file = this.file(id);
    const manifest = this.manifest(file);
    if (!manifest || !Number.isInteger(page) || page < 1 || page > manifest.count)
      throw new HttpError(404, 'No cached page preview.');
    return path.join(this.directory(file), `${page}.jpg`);
  }
  async generate(id: string): Promise<PagePreviewFile> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const work = this.generateOne(id);
    this.pending.set(id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(id);
    }
  }
  private async generateOne(id: string): Promise<PagePreviewFile> {
    const file = this.file(id);
    if (this.manifest(file)) return this.status(id);
    if (!SUPPORTED.has(file.format))
      throw new HttpError(400, 'Page previews are not supported for this file format.');
    if (file.stale) throw new HttpError(409, 'This file changed. Scan its folder first.');
    const dir = this.directory(file);
    const folder = this.db
      .prepare('SELECT * FROM folders WHERE id = ?')
      .get(file.folder_id) as FolderRow;
    const root = await resolveFolderRoot(this.db, this.platform, folder);
    if (!root) throw new HttpError(409, 'Connect the drive containing this book and try again.');
    const abs = joinRel(root, file.rel_path);
    const runner = (this.runner ??= new WorkerPool(1));
    const out = await guardedRead(
      this.db,
      this.platform,
      runner,
      { ...file, abs },
      { kind: 'previews', file: abs, format: file.format },
      { timeoutMs: FILE_TIME_LIMIT_MS, large: file.size >= LARGE_FILE_BYTES },
    ).catch((err: unknown) => {
      if (err instanceof TaskError)
        throw new HttpError(422, `Could not preview this file: ${err.message}`);
      throw err;
    });
    if (!out.ok)
      throw new HttpError(
        409,
        out.refused === 'placeholder'
          ? 'This file is online-only. Download it in your cloud app, then scan its folder and try again.'
          : 'The file is unavailable or changed. Connect its drive and scan its folder, then try again.',
      );
    if (out.result.kind !== 'previews') throw new HttpError(500, 'Could not generate previews.');
    // A scan may update the record during a render; never attach the old pictures to new facts.
    const after = this.file(id);
    const stat = fs.statSync(abs);
    if (
      after.stale ||
      this.stamp(after) !== this.stamp(file) ||
      stat.size !== file.size ||
      (file.modified_ms !== null && Math.round(stat.mtimeMs) !== file.modified_ms)
    )
      throw new HttpError(409, 'The file changed. Scan its folder before trying again.');
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, bytes] of out.result.pages.slice(0, 2).entries())
      fs.writeFileSync(path.join(dir, `${n + 1}.jpg`), bytes);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ stamp: this.stamp(file), count: Math.min(2, out.result.pages.length) }),
    );
    return this.status(id);
  }
  async close() {
    if (this.ownsRunner) await this.runner?.close();
    await Promise.allSettled(this.pending.values());
  }
}

export function registerPagePreviewRoutes(app: Express, previews: PagePreviews) {
  app.get(
    '/api/items/:id/page-previews',
    route((req) => ({ files: previews.forItem(String(req.params.id)) })),
  );
  app.post(
    '/api/files/:id/page-previews',
    route(async (req) => previews.generate(String(req.params.id))),
  );
  app.get('/api/files/:id/page-previews/:page', (req, res, next) => {
    try {
      const file = previews.image(String(req.params.id), Number(req.params.page));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.sendFile(file, { dotfiles: 'allow' });
    } catch (e) {
      next(e);
    }
  });
}
