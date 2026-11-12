// Builds the store collectors' console scripts (store purchases plan, "1a") into
// tools/store-collector/console-scripts/, which is committed so the app (and the GitHub page) can
// hand the script to the owner without a build. Run: npm run build:collector.
// A test checks the committed files match a fresh build.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'rolldown';

const ROOT = path.join(import.meta.dirname, '..', 'tools', 'store-collector');
export const COLLECTOR_SCRIPTS = ['kindle', 'google_play', 'kobo', 'globalcomix', 'probe'] as const;
export const scriptPath = (name: string) => path.join(ROOT, 'console-scripts', `${name}.js`);

/**
 * Bookmark buttons (owner decision 2026-11-12): the same scripts, minified, as a `javascript:`
 * bookmark the owner drags to the bookmarks bar once and clicks on the store's page.
 */
export const BOOKMARKLETS = ['kindle', 'google_play', 'kobo', 'globalcomix'] as const;
export const bookmarkletPath = (name: string) => path.join(ROOT, 'bookmarklets', `${name}.txt`);
/** Browsers keep bookmarks far longer than this; staying under it leaves room everywhere. */
export const BOOKMARKLET_MAX_CHARS = 60_000;

const HEADER = (name: string) =>
  `// whatBooksNext ${name === 'probe' ? 'look-around' : name.replace('_', ' ')} script: paste into the browser console on the\n` +
  `// store's library page while signed in. Read-only. Generated from tools/store-collector by\n` +
  `// npm run build:collector; don't edit by hand.\n`;

/** One console script as text: readable (not minified), so anyone can see what it does. */
export async function bundleCollector(name: string): Promise<string> {
  const out = await build({
    input: path.join(ROOT, 'console', `${name}.ts`),
    write: false,
    logLevel: 'silent',
    output: { format: 'iife', minify: false, comments: { legal: false } },
  });
  // The same text on every OS: LF line ends, and module comments with forward slashes.
  const code = out.output[0]!.code.replace(/\r\n/g, '\n').replace(/^(\s*\/\/ .*)$/gm, (line) =>
    line.replace(/\\/g, '/'),
  );
  return HEADER(name) + code;
}

/** One bookmark: `javascript:` and the minified script, percent-encoded so any character survives. */
export async function bundleBookmarklet(name: string): Promise<string> {
  const out = await build({
    input: path.join(ROOT, 'console', `${name}.ts`),
    write: false,
    logLevel: 'silent',
    output: { format: 'iife', minify: true, comments: { legal: false } },
  });
  const code = out.output[0]!.code.replace(/\r\n/g, '\n').trim();
  return `javascript:${encodeURIComponent(code)}`;
}

if (import.meta.main) {
  fs.mkdirSync(path.join(ROOT, 'bookmarklets'), { recursive: true });
  for (const name of BOOKMARKLETS) {
    fs.writeFileSync(bookmarkletPath(name), await bundleBookmarklet(name));
    console.log(`Built ${path.relative(process.cwd(), bookmarkletPath(name))}`);
  }
  fs.mkdirSync(path.join(ROOT, 'console-scripts'), { recursive: true });
  for (const name of COLLECTOR_SCRIPTS) {
    fs.writeFileSync(scriptPath(name), await bundleCollector(name));
    console.log(`Built ${path.relative(process.cwd(), scriptPath(name))}`);
  }
}
