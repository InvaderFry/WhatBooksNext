// What start-whatBooksNext.bat runs after checking Node: make sure dependencies are installed
// and the web pages are built, check the port is free, then start the app and open a browser.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

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

if (!(await portFree(PORT))) {
  console.error(
    `\nPort ${PORT} is already in use. Is whatBooksNext already running in another window?`,
  );
  console.error(`If something else uses that port, set another one first, e.g.:  set PORT=4819\n`);
  process.exit(1);
}

// Install when there are no dependencies yet, or package-lock.json changed (after an update).
if (mtime('node_modules/.package-lock.json') < mtime('package-lock.json')) {
  console.log('Installing dependencies (first run or after an update)...');
  run(`${npm} ci`);
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
  run(`${npm} run build`);
}

const server = spawn(process.execPath, ['server/src/main.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

// Open the browser once the app answers.
const url = `http://localhost:${PORT}`;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (server.exitCode !== null) break;
  try {
    if ((await fetch(`${url}/api/state`)).ok) {
      if (!process.argv.includes('--no-browser')) {
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
      break;
    }
  } catch {
    /* not up yet */
  }
}
server.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => server.kill('SIGINT'));
