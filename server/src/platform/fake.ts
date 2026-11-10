import path from 'node:path';
import { listWithNode } from './nodeListing.ts';
import type { DirEntry, Platform, StorageKind, VolumeInfo } from './types.ts';

export interface FakeVolume {
  volumeId: string;
  label: string;
  storageKind: StorageKind;
  /** Where the volume is "mounted" now (a real directory on disk). Null = disconnected. */
  root: string | null;
}

/**
 * Test and demo stand-in for the Windows adapter. Real directories play the part of drives;
 * attributes are set per file. Values follow what the M0 probe found: ordinary files are
 * 0x20 (Archive); placeholders carry RecallOnDataAccess/Offline bits.
 */
export class FakePlatform implements Platform {
  readonly name = 'fake' as const;
  readonly supportsPlaceholders = true;
  readonly volumes: FakeVolume[] = [];
  /** Absolute file path -> raw attributes. Files not listed are 0x20 (present). */
  readonly attributes = new Map<string, number>();
  /** Directories whose attributes can't be read (-> files are "unknown"). */
  readonly unreadableAttributeDirs = new Set<string>();
  readonly opened: { action: 'open' | 'show'; path: string }[] = [];
  /** Directories that fail to list (an access error). */
  readonly failingDirs = new Set<string>();
  /** Called before each directory is listed; tests use it to unplug a drive mid-scan. */
  onListDirectory: ((absDir: string) => void) | null = null;

  addVolume(v: FakeVolume): FakeVolume {
    this.volumes.push(v);
    return v;
  }

  private volumeFor(absPath: string): FakeVolume | undefined {
    const full = path.resolve(absPath);
    return this.volumes
      .filter((v) => v.root && (full === v.root || full.startsWith(v.root + path.sep)))
      .sort((a, b) => b.root!.length - a.root!.length)[0];
  }

  async describeVolume(absPath: string): Promise<VolumeInfo> {
    const full = path.resolve(absPath);
    const v = this.volumeFor(full);
    if (!v) {
      return {
        volumeId: null,
        serial: null,
        label: null,
        letter: null,
        root: path.parse(full).root,
        relativePath: path.relative(path.parse(full).root, full),
        storageKind: 'local',
        details: { Volume: 'fake: no volume configured' },
      };
    }
    return {
      volumeId: v.volumeId,
      serial: null,
      label: v.label,
      letter: null,
      root: v.root!,
      relativePath: path.relative(v.root!, full),
      storageKind: v.storageKind,
      details: { Volume: `fake volume "${v.label}"` },
    };
  }

  async findVolumeRoot(volumeId: string): Promise<string | null> {
    return this.volumes.find((v) => v.volumeId === volumeId)?.root ?? null;
  }

  async listDirectory(absDir: string): Promise<DirEntry[]> {
    const dir = path.resolve(absDir);
    this.onListDirectory?.(dir);
    if (this.failingDirs.has(dir)) throw new Error(`EACCES: permission denied, scandir '${dir}'`);
    const unreadable = this.unreadableAttributeDirs.has(dir);
    const entries = await listWithNode(dir, 0x20);
    return entries.map((e) => ({
      ...e,
      attributes: unreadable ? null : (this.attributes.get(path.join(dir, e.name)) ?? e.attributes),
    }));
  }

  async checkAttributes(absFile: string): Promise<number | null> {
    return this.attributes.get(path.resolve(absFile)) ?? 0x20;
  }

  /** Set to make Open / Show in folder fail, as a missing launcher would. */
  launchError: string | null = null;

  async openFile(absFile: string): Promise<void> {
    if (this.launchError) throw new Error(this.launchError);
    this.opened.push({ action: 'open', path: absFile });
  }

  async showInFolder(absFile: string): Promise<void> {
    if (this.launchError) throw new Error(this.launchError);
    this.opened.push({ action: 'show', path: absFile });
  }

  async close(): Promise<void> {}
}
