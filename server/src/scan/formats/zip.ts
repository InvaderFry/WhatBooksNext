import yauzl from 'yauzl';
import { MAX_COMPRESSION_RATIO, MAX_UNCOMPRESSED_BYTES } from '../../config.ts';

/**
 * ZIP access for EPUB and CBZ (yauzl: maintained, pure JS, reads the central directory and only
 * the entries asked for, straight from the file). Archives are read in memory, never extracted
 * to disk, and entry names are never used as paths (§6.1).
 *
 * Limits (§20) are checked from the central directory BEFORE anything is inflated, and again
 * while inflating (yauzl rejects an entry that inflates past its declared size).
 */

export class LimitError extends Error {
  readonly limit: string;
  constructor(limit: string, message: string) {
    super(message);
    this.limit = limit;
  }
}

export interface ArchiveEntry {
  name: string;
  size: number;
  compressedSize: number;
}

/** Ratios are only meaningful for entries of some size: tiny XML files compress very well. */
const RATIO_MIN_BYTES = 1024 * 1024;

export function checkArchiveLimits(entries: ArchiveEntry[]): void {
  let total = 0;
  let packed = 0;
  for (const e of entries) {
    total += e.size;
    packed += e.compressedSize;
    if (e.size > RATIO_MIN_BYTES && e.size > e.compressedSize * MAX_COMPRESSION_RATIO)
      throw new LimitError('ratio', `An entry expands more than ${MAX_COMPRESSION_RATIO}:1.`);
  }
  if (total > MAX_UNCOMPRESSED_BYTES)
    throw new LimitError('size', 'The archive expands to more than 4 GB.');
  if (total > RATIO_MIN_BYTES && total > packed * MAX_COMPRESSION_RATIO)
    throw new LimitError('ratio', `The archive expands more than ${MAX_COMPRESSION_RATIO}:1.`);
}

export class ZipReader {
  readonly entries: ArchiveEntry[];
  private readonly zip: yauzl.ZipFile;
  private readonly byName: Map<string, yauzl.Entry>;

  private constructor(zip: yauzl.ZipFile, entries: yauzl.Entry[]) {
    this.zip = zip;
    const files = entries.filter((e) => !e.fileName.endsWith('/'));
    this.byName = new Map(files.map((e) => [e.fileName, e]));
    this.entries = files.map((e) => ({
      name: e.fileName,
      size: e.uncompressedSize,
      compressedSize: e.compressedSize,
    }));
  }

  /**
   * Opens a ZIP and reads its central directory. Limits are checked here unless the caller
   * checks them itself (comic archives first ask whether they're comics at all).
   */
  static open(file: string, opts: { checkLimits?: boolean } = {}): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      // strictFileNames off: real archives contain backslashes; names are never used as paths.
      yauzl.open(
        file,
        { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: false },
        (err, zip) => {
          if (err || !zip) return reject(err ?? new Error('Not a ZIP archive.'));
          const entries: yauzl.Entry[] = [];
          zip.on('entry', (e: yauzl.Entry) => {
            entries.push(e);
            zip.readEntry();
          });
          zip.on('end', () => {
            const r = new ZipReader(zip, entries);
            try {
              if (opts.checkLimits !== false) checkArchiveLimits(r.entries);
            } catch (e) {
              zip.close();
              return reject(e);
            }
            resolve(r);
          });
          zip.on('error', reject);
          zip.readEntry();
        },
      );
    });
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Finds an entry ignoring case (EPUB hrefs and real archives disagree on case surprisingly often). */
  find(name: string): string | undefined {
    if (this.byName.has(name)) return name;
    const lower = name.toLowerCase();
    for (const k of this.byName.keys()) if (k.toLowerCase() === lower) return k;
    return undefined;
  }

  read(name: string): Promise<Buffer> {
    const entry = this.byName.get(name);
    if (!entry) return Promise.reject(new Error(`No entry "${name}".`));
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('Unreadable entry.'));
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  async readText(name: string): Promise<string> {
    return (await this.read(name)).toString('utf8');
  }

  close(): void {
    this.zip.close();
  }
}
