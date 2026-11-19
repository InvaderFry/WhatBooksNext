import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appVersion, parseBuildInfo } from './appVersion.ts';

const HASH = 'aeb3ee4' + '0'.repeat(33);

function tempApp(buildInfo: string, version = '1.2.3'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbn-version-'));
  fs.mkdirSync(path.join(dir, 'server/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'server/src/build-info.txt'), buildInfo);
  return dir;
}

describe('app version', () => {
  it('reads the commit and date GitHub writes into a downloaded ZIP', () => {
    expect(parseBuildInfo(`${HASH} 2026-11-17T09:30:00-05:00\n`)).toEqual({
      commit: HASH,
      commitDate: '2026-11-17T09:30:00-05:00',
    });
  });

  it('treats the unexpanded placeholder as unknown', () => {
    expect(parseBuildInfo('$Format:%H %cI$\n')).toBeNull();
  });

  it('reports the package version with the ZIP commit', () => {
    const dir = tempApp(`${HASH} 2026-11-17T09:30:00Z`);
    expect(appVersion(dir)).toEqual({
      version: '1.2.3',
      commit: HASH,
      commitDate: '2026-11-17T09:30:00Z',
      source: 'zip',
    });
  });

  it('says the commit is unknown when neither the ZIP nor git tells it', () => {
    const dir = tempApp('$Format:%H %cI$');
    expect(appVersion(dir)).toEqual({
      version: '1.2.3',
      commit: null,
      commitDate: null,
      source: 'unknown',
    });
  });

  it('keeps the committed file as a placeholder for GitHub to fill', () => {
    const file = path.resolve(import.meta.dirname, '../build-info.txt');
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('$Format:%H %cI$');
  });
});
