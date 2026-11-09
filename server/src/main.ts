import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.ts';
import { DEFAULT_PORT, DEV_WEB_PORT } from './config.ts';
import { MigrationError, migrate, openDatabase } from './db/database.ts';
import { buildDemoLibrary } from './lib/demo.ts';
import { createPlatform } from './platform/index.ts';
import type { Platform } from './platform/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const demo = process.env.DEMO === '1';
const dev = process.env.WBN_DEV === '1';
const baseDataDir = path.resolve(process.env.WBN_DATA_DIR ?? path.join(ROOT, 'data'));
// The demo lives in its own folder and is rebuilt on every start; it never touches real data.
const dataDir = demo ? path.join(baseDataDir, 'demo') : baseDataDir;
const snapshotDir = path.join(dataDir, 'snapshots');
const dbFile = path.join(dataDir, 'whatbooksnext.sqlite');

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`PORT must be a number from 1 to 65535 (got "${process.env.PORT}").`);
  if (demo) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const db = openDatabase(dbFile);
  try {
    const m = await migrate(db, { snapshotDir });
    if (m.to !== m.from) console.log(`Database updated from version ${m.from} to ${m.to}.`);
  } catch (err) {
    db.close();
    if (err instanceof MigrationError) {
      fail(
        [
          `The database couldn't be updated (${err.failedMigration}). Nothing was changed, and the app did not start.`,
          `  ${err.message}`,
          err.snapshotPath
            ? `A copy of your data from just before the update is here:\n  ${err.snapshotPath}\n` +
              `To go back: close this window, replace ${dbFile} with that file, and run the previous version of the app.`
            : 'No snapshot was needed (the database was new).',
        ].join('\n'),
      );
    }
    throw err;
  }

  let platform: Platform;
  if (demo) {
    platform = await buildDemoLibrary(db, path.join(dataDir, 'library'));
  } else {
    platform = createPlatform();
  }

  const webDist = path.join(ROOT, 'web', 'dist');
  const { app, close } = createApp({
    db,
    platform,
    port,
    devPorts: dev ? [DEV_WEB_PORT] : [],
    dataDir,
    snapshotDir,
    webDist: dev ? null : webDist,
    demo,
  });

  // Bound to 127.0.0.1 only: never reachable from other machines (§4, §6.3).
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(
      `whatBooksNext${demo ? ' (DEMO library)' : ''} is running at http://localhost:${port}`,
    );
    if (!dev && !fs.existsSync(path.join(webDist, 'index.html'))) {
      console.log('The web pages are not built yet: run "npm run build" first.');
    }
    console.log('Keep this window open while you use the app. Press Ctrl+C to stop.');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      fail(
        `Port ${port} is already in use — is whatBooksNext already running? If something else uses it, start with another port, e.g. set PORT=4819.`,
      );
    }
    fail(err.message);
  });

  const shutdown = async () => {
    server.close();
    await close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
