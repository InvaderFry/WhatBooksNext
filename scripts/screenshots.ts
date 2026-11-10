// Drives the demo library in a real browser and saves screenshots to screenshots/ (gitignored),
// so wrapping, light/dark and keyboard focus can be looked at (PLAN.md §5). Uses the demo only,
// never the owner's library. Needs Playwright with a Chromium: `npx playwright install chromium`
// if your machine doesn't have one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = 4877;
const BASE = `http://localhost:${PORT}`;

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

const server = spawn(process.execPath, ['server/src/main.ts'], {
  cwd: ROOT,
  env: { ...process.env, DEMO: '1', PORT: String(PORT), WBN_DATA_DIR: path.join(OUT, '.data') },
  stdio: 'inherit',
});

try {
  fs.mkdirSync(OUT, { recursive: true });
  await waitForServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const shots: [string, string, (p: import('playwright').Page) => Promise<void>][] = [
    ['next', '/', async () => {}],
    ['next-finish-within', '/?time=30&mode=finish_within', async () => {}],
    [
      'next-not-this',
      '/?time=120',
      async (p) => {
        await p.getByRole('button', { name: 'Not this, because…' }).first().click();
      },
    ],
    ['triage', '/?view=triage', async () => {}],
    ['library', '/?view=library', async () => {}],
    ['library-filtered', '/?view=library&ready=1&kind=comic', async () => {}],
    [
      'item-tie',
      '/?view=library&q=puddles',
      async (p) => {
        await p
          .getByRole('link', { name: /Field Guide to Puddles/i })
          .first()
          .click();
        await p.getByRole('heading', { name: 'Ratings and details' }).waitFor();
      },
    ],
    [
      'item',
      '/?view=library',
      async (p) => {
        await p.getByRole('link', { name: /^Glass Harbor$/ }).click();
        await p.getByRole('heading', { level: 1 }).waitFor();
      },
    ],
    [
      'item-online-only',
      '/?view=library',
      async (p) => {
        await p.getByRole('link', { name: 'Night Orchard' }).click();
        await p.getByRole('button', { name: 'Open nightorchard.epub' }).click();
        await p.getByRole('alertdialog').waitFor();
      },
    ],
    [
      'item-series',
      '/?view=library&q=copperline',
      async (p) => {
        await p.getByRole('link', { name: /Copperline #2/ }).click();
        await p.getByRole('heading', { name: 'Series' }).waitFor();
        await p.getByRole('button', { name: 'Correct series or number' }).click();
      },
    ],
    [
      'item-series-finished',
      '/?view=library&q=clocks',
      async (p) => {
        await p
          .getByRole('link', { name: /River of Clocks/ })
          .first()
          .click();
        await p.getByRole('heading', { name: 'Series' }).waitFor();
      },
    ],
    [
      'item-collects',
      '/?view=library&q=copperline',
      async (p) => {
        await p
          .getByRole('link', { name: /Copperline Vol\. 2/ })
          .first()
          .click();
        await p.getByRole('heading', { name: 'Collects' }).waitFor();
      },
    ],
    [
      'item-published-volumes',
      '/?view=library&q=copperline',
      async (p) => {
        await p
          .getByRole('link', { name: /Copperline Vol\. 1/ })
          .first()
          .click();
        await p.getByRole('heading', { name: 'Published volumes' }).waitFor();
        await p.getByText(/Published volumes not recorded as owned or read: volumes 3–4/).waitFor();
        await p.getByText('Show the 2 missing published volumes').click();
      },
    ],
    [
      'item-merge',
      '/?view=library&q=river',
      async (p) => {
        // The demo's River of Clocks is an EPUB on the drive and a PDF in iCloud: one book.
        await p
          .getByRole('link', { name: /River of Clocks/ })
          .first()
          .click();
        await p.getByRole('button', { name: 'Merge with another entry…' }).click();
        await p.getByLabel('Find the other entry').fill('river');
        await p.locator('#merge-h ~ form button[type=submit]').click();
        await p.locator('.plain-list button').first().click();
        await p.getByRole('button', { name: 'Merge', exact: true }).waitFor();
      },
    ],
    [
      'item-split',
      '/?view=library&q=glass',
      async (p) => {
        await p
          .getByRole('link', { name: /Glass Harbor/ })
          .first()
          .click();
        await p.getByRole('heading', { name: 'Not all the same book?' }).waitFor();
        await p.locator('.checks input').last().check();
        await p.getByRole('button', { name: 'Preview the split…' }).click();
        await p.getByRole('button', { name: 'Split', exact: true }).waitFor();
      },
    ],
    [
      'library-add-store',
      '/?view=library',
      async (p) => {
        await p.getByRole('button', { name: 'Add a store book…' }).click();
        await p.getByRole('button', { name: 'Type it in' }).click();
      },
    ],
    [
      'item-store',
      '/?view=library&q=cartographer',
      async (p) => {
        await p
          .getByRole('link', { name: /Cartographer of Small Rains/ })
          .first()
          .click();
        await p.getByRole('heading', { name: 'In a store app' }).waitFor();
      },
    ],
    [
      'settings-csv',
      '/?view=settings',
      async (p) => {
        await p.getByLabel('CSV file', { exact: true }).setInputFiles({
          name: 'my-kindle-books.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'title,author,store,progress,rating\n' +
              'The Cartographer of Small Rains,Wenna Holloway,Kindle,read,4/5\n' +
              'Glass Harbor,Mira Vantongeren,Apple Books,,\n' +
              'The Orchard Ledger,Pim Arkwright,Kindle,to-read,\n',
          ),
        });
        await p.getByRole('button', { name: 'Import', exact: true }).waitFor();
        await p
          .getByRole('heading', { name: 'Store books from a spreadsheet' })
          .scrollIntoViewIfNeeded();
      },
    ],
    ...(['goodreads', 'storygraph'] as const).map(
      (source): [string, string, (p: import('playwright').Page) => Promise<void>] => [
        `settings-history-${source}`,
        '/?view=settings',
        async (p) => {
          await p.getByLabel('History source').selectOption(source);
          await p
            .getByLabel('Reading history CSV file')
            .setInputFiles(path.join(ROOT, 'fixtures', 'imports', `${source}.csv`));
          await p.getByRole('button', { name: 'Import reading history', exact: true }).waitFor();
          await p.getByRole('button', { name: 'Cancel history import' }).click();
          await p
            .getByLabel('Reading history CSV file')
            .setInputFiles(path.join(ROOT, 'fixtures', 'imports', `${source}.csv`));
          await p.getByRole('button', { name: 'Import reading history', exact: true }).waitFor();
          await p.locator('#history-import-h').scrollIntoViewIfNeeded();
        },
      ],
    ),
    ['shortlist', '/?view=shortlist', async () => {}],
    [
      'keyboard-focus',
      '/?view=shortlist',
      async (p) => {
        // Skip link, brand, then the nav: focus must be visible at every stop.
        for (let i = 0; i < 3; i++) await p.keyboard.press('Tab');
      },
    ],
    [
      'item-comic-pdf',
      '/?view=library',
      async (p) => {
        await p.getByRole('link', { name: /Shadow Service/ }).click();
        await p.getByRole('heading', { level: 1 }).waitFor();
      },
    ],
    [
      'review',
      '/?view=review',
      async (p) => {
        await p.locator('details.tier4 > summary').click(); // tier 4 is collapsed by default
      },
    ],
    ['health', '/?view=health', async () => {}],
    ['settings', '/?view=settings', async () => {}],
    ['diagnostics', '/?view=diagnostics', async () => {}],
  ];
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, label] of [
      [1280, 'desktop'],
      [390, 'phone'],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      for (const [name, url, act] of shots) {
        await page.goto(BASE + url);
        await page.waitForLoadState('networkidle');
        await act(page);
        await page.waitForTimeout(150);
        await page.screenshot({
          path: path.join(OUT, `${name}-${label}-${scheme}.png`),
          fullPage: true,
        });
      }
      await page.close();
    }
  }
  await browser.close();
  console.log(`Screenshots in ${OUT}`);
} finally {
  server.kill();
}
