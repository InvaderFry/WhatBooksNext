// Development: the API server (with the Vite port allowed, §6.3) plus Vite's dev server.
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const server = spawn(process.execPath, ['--watch', 'server/src/main.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, WBN_DEV: '1' },
});
const web = spawn(npx, ['vite'], {
  cwd: path.join(ROOT, 'web'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const stop = () => {
  server.kill();
  web.kill();
};
process.on('SIGINT', stop);
server.on('exit', stop);
web.on('exit', stop);
console.log('Open http://localhost:5173');
