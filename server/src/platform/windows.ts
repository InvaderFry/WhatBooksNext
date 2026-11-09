import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import fs from 'node:fs';
import { listWithNode } from './nodeListing.ts';
import {
  ATTR_DIRECTORY,
  ATTR_REPARSE_POINT,
  type DirEntry,
  type Platform,
  type StorageKind,
  type VolumeInfo,
} from './types.ts';
import { WINDOWS_HELPER_SCRIPT } from './windowsHelper.ps1.ts';

/** A request that takes longer than this is treated as failed (attributes then read as unknown). */
const HELPER_TIMEOUT_MS = 30_000;

/** Bus types that mean a removable/external disk. The owner's USB drive reports DriveType Fixed (M0). */
const EXTERNAL_BUS_TYPES = new Set(['USB', 'SD', 'MMC', '1394', 'Thunderbolt']);
const DRIVE_TYPE_REMOVABLE = 2;
const DRIVE_TYPE_NETWORK = 4;

interface HelperReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** One long-lived PowerShell process answering JSON-line requests (§9.5). */
export class PowerShellHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly executable: string;

  constructor(executable = process.env.WBN_POWERSHELL ?? 'powershell.exe') {
    this.executable = executable;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    // -EncodedCommand takes UTF-16LE base64, which avoids every quoting problem.
    const encoded = Buffer.from(WINDOWS_HELPER_SCRIPT, 'utf16le').toString('base64');
    const proc = spawn(
      this.executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    proc.stdout.setEncoding('utf8');
    proc.stdin.setDefaultEncoding('utf8');
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', () => {
      /* PowerShell progress noise; failures arrive as JSON replies */
    });
    const failAll = (why: string) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
        this.pending.delete(id);
      }
      if (this.proc === proc) this.proc = null;
    };
    proc.on('exit', () => failAll('PowerShell helper exited'));
    proc.on('error', (err) => failAll(`PowerShell helper could not start: ${err.message}`));
    this.proc = proc;
    return proc;
  }

  private onLine(line: string) {
    let reply: HelperReply;
    try {
      reply = JSON.parse(line) as HelperReply;
    } catch {
      return;
    }
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error ?? 'helper error'));
  }

  request(op: string, args: Record<string, string>): Promise<unknown> {
    const proc = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PowerShell helper timed out on ${op}`));
      }, HELPER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      proc.stdin.end();
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill();
          r();
        }, 2000);
        proc.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

interface VolumeDetails {
  root: string;
  letter: string | null;
  volumeId: string | null;
  serial: string | null;
  label: string | null;
  driveType: number | null;
  busType: string | null;
  fileSystem: string | null;
}

export function storageKindFor(
  d: Pick<VolumeDetails, 'busType' | 'driveType'>,
  absPath: string,
  cloudRoots: string[],
): StorageKind {
  const lower = absPath.toLowerCase();
  if (cloudRoots.some((r) => r && (lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + '\\')))) {
    return 'cloud';
  }
  if (d.busType && EXTERNAL_BUS_TYPES.has(d.busType)) return 'external';
  if (d.driveType === DRIVE_TYPE_REMOVABLE || d.driveType === DRIVE_TYPE_NETWORK) return 'external';
  if (absPath.startsWith('\\\\')) return 'external'; // network share: can go away like a drive
  return 'local';
}

/** Known cloud-sync roots for this user (iCloud Drive, OneDrive). */
function cloudRoots(): string[] {
  const roots: string[] = [];
  if (process.env.USERPROFILE) roots.push(path.win32.join(process.env.USERPROFILE, 'iCloudDrive'));
  for (const v of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[v]) roots.push(process.env[v]!);
  }
  return roots;
}

export class WindowsPlatform implements Platform {
  readonly name = 'windows' as const;
  readonly supportsPlaceholders = true;
  private readonly helper: PowerShellHelper;

  constructor(helper = new PowerShellHelper()) {
    this.helper = helper;
  }

  async describeVolume(absPath: string): Promise<VolumeInfo> {
    const full = path.win32.resolve(absPath);
    let d: VolumeDetails;
    try {
      d = (await this.helper.request('volume', { path: full })) as VolumeDetails;
    } catch (err) {
      d = {
        root: path.win32.parse(full).root,
        letter: /^[A-Za-z]:/.test(full) ? full[0]!.toUpperCase() : null,
        volumeId: null,
        serial: null,
        label: null,
        driveType: null,
        busType: null,
        fileSystem: null,
      };
      d.label = `(volume details unavailable: ${(err as Error).message})`;
    }
    const root = d.root || path.win32.parse(full).root;
    return {
      volumeId: d.volumeId || null,
      serial: d.serial || null,
      label: d.label || null,
      letter: d.letter || null,
      root,
      relativePath: path.win32.relative(root, full),
      storageKind: storageKindFor(d, full, cloudRoots()),
      details: {
        'Drive letter': d.letter ? `${d.letter}:` : 'none',
        'Volume id': d.volumeId ?? 'unknown',
        'Volume serial': d.serial ?? 'unknown',
        'Bus type': d.busType ?? 'unknown',
        'Drive type': d.driveType === null ? 'unknown' : String(d.driveType),
        'File system': d.fileSystem ?? 'unknown',
      },
    };
  }

  async findVolumeRoot(volumeId: string): Promise<string | null> {
    try {
      const r = await this.helper.request('find', { volumeId });
      return typeof r === 'string' && r ? r : null;
    } catch {
      return null;
    }
  }

  async listDirectory(absDir: string): Promise<DirEntry[]> {
    let rows: [string, number, number, number, number][];
    try {
      rows = (await this.helper.request('list', { path: absDir })) as typeof rows;
    } catch (err) {
      if (/timed out|exited|could not start/.test((err as Error).message)) {
        // Helper unavailable: list with Node, attributes unknown (never treated as present).
        return listWithNode(absDir, null);
      }
      throw err;
    }
    const out: DirEntry[] = [];
    for (const [name, attributes, size, modifiedMs, createdMs] of rows) {
      const isDirectory = (attributes & ATTR_DIRECTORY) !== 0;
      let isLink = false;
      if (isDirectory && (attributes & ATTR_REPARSE_POINT) !== 0) {
        // Junctions/symlinks are reparse points, but so are cloud-sync folders, which we follow.
        // lstat opens the reparse point itself, not its target, so it recalls nothing.
        try {
          isLink = (await fs.promises.lstat(path.win32.join(absDir, name))).isSymbolicLink();
        } catch {
          isLink = true;
        }
      }
      out.push({ name, isDirectory, isLink, size, modifiedMs, createdMs, attributes });
    }
    return out;
  }

  async checkAttributes(absFile: string): Promise<number | null> {
    try {
      const r = await this.helper.request('file', { path: absFile });
      return typeof r === 'number' ? r : null;
    } catch {
      return null;
    }
  }

  async openFile(absFile: string): Promise<void> {
    // explorer.exe with a file path opens it with the default app. The path comes from the
    // database, is passed as one argument, and Windows paths cannot contain a double quote.
    launch('explorer.exe', [absFile], false);
  }

  async showInFolder(absFile: string): Promise<void> {
    launch('explorer.exe', [`/select,"${absFile.replace(/"/g, '')}"`], true);
  }

  close(): Promise<void> {
    return this.helper.close();
  }
}

function launch(cmd: string, args: string[], verbatim: boolean) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: verbatim,
  });
  child.on('error', () => {});
  child.unref();
}
