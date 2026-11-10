import { describe, expect, it } from 'vitest';
import { launchDetached } from './launch.ts';

describe('launching Open / Show in folder', () => {
  it('settles only once the program has really started', async () => {
    await expect(launchDetached(process.execPath, ['-e', ''])).resolves.toBeUndefined();
  });

  it('fails when the launcher is missing, instead of reporting success', async () => {
    await expect(launchDetached('wbn-no-such-launcher-xyz', [])).rejects.toThrow(
      /Couldn't start wbn-no-such-launcher-xyz/,
    );
  });
});
