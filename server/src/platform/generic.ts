import path from 'node:path';
import { launchDetached } from './launch.ts';
import { listWithNode } from './nodeListing.ts';
import type { DirEntry, Platform, VolumeInfo } from './types.ts';

/**
 * Fallback for macOS and Linux: "should mostly work, untested" in v1 (PLAN.md §4). No drive
 * identity (folders are found by path) and no placeholder detection (files count as present).
 */
export class GenericPlatform implements Platform {
  readonly name = 'generic' as const;
  readonly supportsPlaceholders = false;

  async describeVolume(absPath: string): Promise<VolumeInfo> {
    const full = path.resolve(absPath);
    const root = path.parse(full).root;
    return {
      volumeId: null,
      serial: null,
      label: null,
      letter: null,
      root,
      relativePath: path.relative(root, full),
      storageKind: 'local',
      details: { Platform: `${process.platform} (no drive identity; found by path)` },
    };
  }

  async findVolumeRoot(): Promise<string | null> {
    return null;
  }

  listDirectory(absDir: string): Promise<DirEntry[]> {
    return listWithNode(absDir, 0);
  }

  async checkAttributes(): Promise<number | null> {
    return 0;
  }

  async openFile(absFile: string): Promise<void> {
    await launchDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [absFile]);
  }

  async showInFolder(absFile: string): Promise<void> {
    if (process.platform === 'darwin') await launchDetached('open', ['-R', absFile]);
    else await launchDetached('xdg-open', [path.dirname(absFile)]);
  }

  async close(): Promise<void> {}
}
