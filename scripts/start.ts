// What start-whatBooksNext.bat runs after checking Node: make sure dependencies are installed
// and the web pages are built, check the port is free, then start the app and open a browser.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { appVersion } from '../server/src/lib/appVersion.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 4818);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string) {
  execSync(cmd, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  });
}

function mtime(p: string): number {
  try {
    return fs.statSync(path.join(ROOT, p)).mtimeMs;
  } catch {
    return 0;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function openBrowser(url: string) {
  if (process.argv.includes('--no-browser')) return;
  const opener =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

const url = `http://localhost:${PORT}`;

/** Is the running app the one in this folder? Unknown on either side counts as different. */
function sameVersion(
  running: { version?: unknown; commit?: unknown },
  disk: { version: string | null; commit: string | null },
): boolean {
  if (typeof running.version !== 'string' || running.version !== disk.version) return false;
  // Same number: also compare commits when both are known.
  return !(typeof running.commit === 'string' && disk.commit && running.commit !== disk.commit);
}

function describe(v: { version?: unknown; commit?: unknown }): string {
  if (typeof v.version !== 'string') return 'an older version';
  return typeof v.commit === 'string' ? `${v.version}, ${v.commit.slice(0, 7)}` : v.version;
}

if (!(await portFree(PORT))) {
  // Double-clicking the start file again while the app runs just opens it.
  let alreadyRunning = false;
  let running: { version?: unknown; commit?: unknown } = {};
  try {
    const state = (await (await fetch(`${url}/api/state`)).json()) as {
      demo?: unknown;
      version?: unknown;
      commit?: unknown;
    };
    alreadyRunning = typeof state.demo === 'boolean';
    running = state;
  } catch {
    /* something else is on the port */
  }
  const onDisk = appVersion(ROOT);
  if (alreadyRunning && !sameVersion(running, onDisk)) {
    // After an update, the old copy keeps serving the old pages until its window is closed.
    console.error(
      [
        '',
        'An older copy of whatBooksNext is still running in another window, so this update',
        `isn't in use yet (running: ${describe(running)}; this folder: ${describe(onDisk)}).`,
        'Close the other black whatBooksNext window (or press Ctrl+C in it), then start again.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (alreadyRunning) {
    console.log(`\nwhatBooksNext is already running in another window. Opening ${url} ...\n`);
    openBrowser(url);
    process.exit(0);
  }
  console.error(`\nPort ${PORT} is used by another program, so whatBooksNext can't start.`);
  console.error('Close that program, or start whatBooksNext on another port (see INSTALL.md).\n');
  process.exit(1);
}

// Install when there are no dependencies yet, or package-lock.json changed (after an update).
if (mtime('node_modules/.package-lock.json') < mtime('package-lock.json')) {
  console.log('Installing dependencies (first run or after an update)...');
  try {
    run(`${npm} ci`);
  } catch {
    console.error(
      [
        '',
        'Installing dependencies failed (details above).',
        '- If you see EPERM or "operation not permitted": another program (File Explorer, an',
        '  editor, antivirus or a sync app) is holding files in the node_modules folder. Close it,',
        '  delete the node_modules folder, and start again.',
        '- If it mentions a network error, check the internet connection and start again.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

// Rebuild the web pages when any of their sources is newer than the build.
const newestSource = Math.max(
  ...['web/index.html', 'web/vite.config.ts', 'package-lock.json'].map(mtime),
  ...fs
    .readdirSync(path.join(ROOT, 'web/src'), { recursive: true })
    .map((f) => mtime(path.join('web/src', String(f)))),
);
if (mtime('web/dist/index.html') < newestSource) {
  console.log('Building the web pages...');
  try {
    run(`${npm} run build`);
  } catch {
    console.error(
      '\nBuilding the web pages failed (details above). Delete node_modules and start again.\n',
    );
    process.exit(1);
  }
}

const server = spawn(process.execPath, ['server/src/main.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

// Open the browser once the app answers.
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (server.exitCode !== null) break;
  try {
    if ((await fetch(`${url}/api/state`)).ok) {
      openBrowser(url);
      break;
    }
  } catch {
    /* not up yet */
  }
}
server.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => server.kill('SIGINT'));
