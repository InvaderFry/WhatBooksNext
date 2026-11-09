import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PowerShellHelper, WindowsPlatform, storageKindFor } from './windows.ts';

// Runs against real PowerShell: on Windows (CI's windows-latest), or anywhere WBN_POWERSHELL
// points at a PowerShell executable. It proves the helper's protocol and listing work there;
// it can't prove anything about iCloud placeholders, which need checking on the owner's PC.
const canRun = process.platform === 'win32' || Boolean(process.env.WBN_POWERSHELL);

describe.runIf(canRun)('PowerShell helper (real PowerShell)', () => {
  let dir: string;
  let helper: PowerShellHelper;
  let platform: WindowsPlatform;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbn-helper-'));
    fs.writeFileSync(path.join(dir, 'café notes.epub'), 'x'.repeat(1234));
    fs.mkdirSync(path.join(dir, 'Comics'));
    helper = new PowerShellHelper();
    platform = new WindowsPlatform(helper);
  });

  afterAll(async () => {
    await platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists names, sizes, dates and attributes without opening files, keeping non-ASCII names', async () => {
    const entries = await platform.listDirectory(dir);
    const file = entries.find((e) => e.name === 'café notes.epub');
    expect(file).toMatchObject({ isDirectory: false, isLink: false, size: 1234 });
    expect(file?.attributes).toEqual(expect.any(Number));
    expect(Math.abs((file?.modifiedMs ?? 0) - fs.statSync(path.join(dir, 'café notes.epub')).mtimeMs)).toBeLessThan(2000);
    expect(entries.find((e) => e.name === 'Comics')).toMatchObject({ isDirectory: true });
  }, 30_000);

  it('answers many requests from one long-lived process', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await platform.listDirectory(dir);
    // Starting PowerShell costs ~1 s; twenty listings through one helper must be far quicker
    // than twenty starts.
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('reports a directory it cannot list as an error, not as empty', async () => {
    await expect(platform.listDirectory(path.join(dir, 'no-such-dir'))).rejects.toThrow();
  }, 30_000);

  it('reads one file\u2019s attributes for the pre-read re-check', async () => {
    expect(await platform.checkAttributes(path.join(dir, 'café notes.epub'))).toEqual(expect.any(Number));
  }, 30_000);
});

describe('storage kind', () => {
  it('calls a USB disk external even though Windows reports it as Fixed (M0 probe)', () => {
    expect(storageKindFor({ busType: 'USB', driveType: 3 }, 'E:\\Books', [])).toBe('external');
  });

  it('calls a SATA/NVMe system disk local', () => {
    expect(storageKindFor({ busType: 'NVMe', driveType: 3 }, 'C:\\Books', [])).toBe('local');
  });

  it('calls a folder inside a cloud-sync root cloud', () => {
    expect(
      storageKindFor({ busType: 'NVMe', driveType: 3 }, 'C:\\Users\\x\\iCloudDrive\\Books', [
        'C:\\Users\\x\\iCloudDrive',
      ]),
    ).toBe('cloud');
  });
});
