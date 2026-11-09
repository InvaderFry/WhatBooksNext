// Benchmark (PLAN.md §17): ~5,000 synthetic, invented files. Measures the light scan, the deep
// pass (reading, then fingerprinting), loading the Library, and how quickly the app answers
// while a deep scan runs. Uses the generic adapter (no PowerShell), so it says nothing about
// a real USB drive on Windows: synthetic numbers don't prove real-drive performance (§5).
//
//   node scripts/benchmark.ts [files]      (default 5000)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/src/app.ts';
import { migrate, openDatabase } from '../server/src/db/database.ts';
import { GenericPlatform } from '../server/src/platform/generic.ts';
import { makeCbz, makeEpub, makePdf, textLines } from '../server/src/testing/fixtures.ts';
import { fillerFor } from '../server/src/testing/helpers.ts';

const total = Number(process.argv[2] ?? 5000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbn-bench-'));
const lib = path.join(root, 'library');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// A mix like the owner's drive (M0/M1): mostly EPUB and PDF, some comics, some MOBI.
// Contents are small templates made unique per file, so generation stays quick.
const templates = {
  epub: makeEpub({ title: 'Bench', chapters: [3000, 3000, 3000], cover: true }),
  pdf: makePdf({ pages: Array.from({ length: 12 }, (_, i) => ({ text: textLines(40, i) })) }),
  cbz: makeCbz({ pages: 12, width: 600, height: 920 }),
};
console.log(`Writing ${total} files to ${lib} …`);
for (let i = 0; i < total; i++) {
  const dir = path.join(lib, `bundle${String(Math.floor(i / 12)).padStart(3, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const kind = i % 10 < 4 ? 'epub' : i % 10 < 7 ? 'pdf' : i % 10 < 9 ? 'cbz' : 'mobi';
  const name = `book${i}.${kind}`;
  const data =
    kind === 'mobi'
      ? fillerFor(name, 400_000)
      : // Trailing bytes keep each file unique (and distinct by hash) without regenerating it.
        Buffer.concat([templates[kind as 'epub' | 'pdf' | 'cbz'], Buffer.from(`\n%${name}\n`)]);
  fs.writeFileSync(path.join(dir, name), data);
}

const db = openDatabase(path.join(dataDir, 'bench.sqlite'));
await migrate(db, { snapshotDir: null });
// A fixed port: the request guard checks the Host header against it (§6.3).
const port = 4879;
const app2 = createApp({ db, platform: new GenericPlatform(), port, dataDir, snapshotDir: null });
const server2 = app2.app.listen(port, '127.0.0.1');
await new Promise((r) => server2.once('listening', r));
const base = `http://localhost:${port}`;
const call = (url: string, init?: RequestInit) =>
  fetch(base + url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Host: `localhost:${port}` },
  });

await call('/api/folders', { method: 'POST', body: JSON.stringify({ path: lib }) });
const t0 = performance.now();
await call('/api/scan', { method: 'POST', body: '{}' });

// Poll the Library while the scan runs: how long does a page of it take to come back?
const latencies: number[] = [];
let lightDone = 0;
let readDone = 0;
for (;;) {
  const s0 = performance.now();
  await (await call('/api/items?limit=50')).json();
  latencies.push(performance.now() - s0);
  const st = (await (await call('/api/scan')).json()) as {
    status: { status: string; phase: string };
  };
  const now = performance.now() - t0;
  if (!lightDone && st.status.phase !== 'listing') lightDone = now;
  if (!readDone && (st.status.phase === 'hashing' || st.status.phase === 'finishing'))
    readDone = now;
  if (st.status.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 200));
}
const scanMs = performance.now() - t0;

const l0 = performance.now();
const all = (await (await call('/api/items?limit=1000')).json()) as { total: number };
const libraryMs = performance.now() - l0;

const rescan0 = performance.now();
await call('/api/scan', { method: 'POST', body: '{}' });
await app2.scans.wait();
const rescanMs = performance.now() - rescan0;

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!;
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
console.log(
  [
    `Machine: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} vCPU, ${Math.round(os.totalmem() / 1024 ** 3)} GB, ${process.platform}, Node ${process.version}`,
    `Files: ${total} (40% EPUB, 30% PDF, 20% CBZ, 10% MOBI); items: ${all.total}`,
    `Light scan (listing, names, grouping): ${s(lightDone)}`,
    `Deep pass, reading (metadata, counts, PDF type, covers): ${s(readDone - lightDone)}`,
    `Deep pass, fingerprinting (full hashes) and finishing: ${s(scanMs - readDone)}`,
    `Whole first scan: ${s(scanMs)}`,
    `Rescan with nothing changed: ${s(rescanMs)}`,
    `Library, 1,000 items in one request: ${libraryMs.toFixed(0)} ms`,
    `Library page during the scan (${latencies.length} requests): median ${pct(0.5).toFixed(0)} ms, 95th percentile ${pct(0.95).toFixed(0)} ms, worst ${latencies.at(-1)!.toFixed(0)} ms`,
  ].join('\n'),
);
server2.close();
await app2.close();
db.close();
fs.rmSync(root, { recursive: true, force: true });
