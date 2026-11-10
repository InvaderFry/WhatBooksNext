import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Starts a launcher (explorer.exe, open, xdg-open) detached, and settles once the OS has either
 * started it or refused to. A missing or unstartable launcher rejects, so callers (and
 * Diagnostics) never report an Open that didn't happen.
 *
 * What it can't tell: whether the launcher then found an app for the file. explorer.exe exits
 * with code 1 even when it succeeds, so its exit code proves nothing either way.
 */
export function launchDetached(
  cmd: string,
  args: string[],
  options: Pick<SpawnOptions, 'windowsHide' | 'windowsVerbatimArguments'> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { ...options, detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(new Error(`Couldn't start ${cmd}: ${(err as Error).message}`));
      return;
    }
    child.once('spawn', () => {
      // Errors after a successful start (none are expected) mustn't crash the server.
      child.on('error', () => {});
      child.unref();
      resolve();
    });
    child.once('error', (err) => reject(new Error(`Couldn't start ${cmd}: ${err.message}`)));
  });
}
