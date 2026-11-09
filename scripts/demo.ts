// `npm run demo`: the invented demo library, rebuilt fresh on every start (PLAN.md §17).
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const child = spawn(process.execPath, ['scripts/start.ts', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DEMO: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
