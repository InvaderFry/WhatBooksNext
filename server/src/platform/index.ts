import { GenericPlatform } from './generic.ts';
import type { Platform } from './types.ts';
import { WindowsPlatform } from './windows.ts';

export function createPlatform(): Platform {
  return process.platform === 'win32' ? new WindowsPlatform() : new GenericPlatform();
}
