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

/**
 * A quick accessibility pass on the page as shown (PLAN.md §5): names on every control, labels
 * on every field, unique ids, one h1, no skipped heading levels, alt text, and no sideways
 * scrolling. Not a full audit; it catches the mistakes whatGamesNext's tests missed.
 */
async function audit(page: import('playwright').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && (r.width > 0 || r.height > 0);
    };
    const nameOf = (el: Element): string => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled)
        return labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      const aria = el.getAttribute('aria-label');
      if (aria?.trim()) return aria.trim();
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        const own = el.labels?.[0]?.textContent?.trim();
        if (own) return own;
        if (el instanceof HTMLInputElement && ['submit', 'button'].includes(el.type))
          return el.value;
        return el.getAttribute('title') ?? '';
      }
      const alt = [...el.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join(' ');
      return `${el.textContent ?? ''} ${alt}`.trim();
    };
    const desc = (el: Element) =>
      `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}> "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    for (const el of document.querySelectorAll('button, a[href], [role=button]'))
      if (visible(el) && !nameOf(el)) out.push(`no accessible name: ${desc(el)}`);
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el instanceof HTMLInputElement && ['hidden', 'submit', 'button'].includes(el.type))
        continue;
      if (!nameOf(el)) out.push(`field without a label: ${desc(el)}`);
    }
    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push(`id "${id}" used ${n} times`);
    const h1 = [...document.querySelectorAll('h1')].filter(visible).length;
    if (h1 !== 1) out.push(`${h1} visible h1 headings`);
    let last = 1;
    for (const h of document.querySelectorAll(
      'main h1, main h2, main h3, main h4, main h5, main h6',
    )) {
      if (!visible(h)) continue;
      const level = Number(h.tagName[1]);
      if (level > last + 1) out.push(`heading jumps from h${last} to h${level}: ${desc(h)}`);
      last = level;
    }
    for (const img of document.querySelectorAll('img:not([alt])'))
      out.push(`image without alt: ${desc(img)}`);
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide)`);
    return out;
  });
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
    // M5: every mode populated, a truthful empty case, and the new pages.
    ...(
      [
        'continue',
        'next_in_series',
        'one_sitting',
        'waiting',
        'hidden_gems',
        'classics',
        'still_relevant',
        'surprise',
      ] as const
    ).map(
      (m) =>
        [`mode-${m}`, `/?m=${m}`, async () => {}] as [
          string,
          string,
          (p: import('playwright').Page) => Promise<void>,
        ],
    ),
    ['mode-mood-learn', '/?m=mood&mood=learn', async () => {}],
    ['mode-mood-skim', '/?m=mood&mood=skim', async () => {}],
    ['mode-complete-only', '/?complete=1', async () => {}],
    ['mode-empty-classics-comics', '/?m=classics&show=comics', async () => {}],
    [
      'mode-still-reading-dnf',
      '/?m=continue',
      async (p) => {
        await p.getByRole('button', { name: 'Did not finish' }).first().click();
      },
    ],
    ['tune', '/?view=tune', async () => {}],
    [
      'triage-bulk-preview',
      '/?view=triage&bulk=1',
      async (p) => {
        await p.getByRole('checkbox').nth(1).check();
        await p.getByRole('checkbox').nth(2).check();
        await p.getByRole('button', { name: /^Already read/ }).click();
        await p.getByRole('heading', { name: /^Mark 2 books/ }).waitFor();
      },
    ],
    ['triage-folder', '/?view=triage&source=folder', async () => {}],
    ['triage', '/?view=triage', async () => {}],
    ['library', '/?view=library', async () => {}],
    ['library-filtered', '/?view=library&ready=1&kind=comic', async () => {}],
    ['library-online-rating', '/?view=library&sort=community&dir=desc', async () => {}],
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
      'item-rating-unconfirmed',
      '/?view=library&q=river',
      async (p) => {
        await p
          .getByRole('link', { name: /River of Clocks/ })
          .first()
          .click();
        const confirm = p.getByRole('link', { name: 'Check and confirm this match' });
        await confirm.focus();
        await p.keyboard.press('Enter');
        await p.locator('#possible-matches[open]').waitFor();
        await p
          .getByRole('button', { name: /^This is it:/ })
          .first()
          .waitFor();
      },
    ],
    [
      'item-from-each-source',
      '/?view=library&q=glass',
      async (p) => {
        await p
          .getByRole('link', { name: /Glass Harbor/ })
          .first()
          .click();
        await p.getByText(/^From each source/).click();
        await p.locator('.from-each-source[open] .source-entry').first().waitFor();
      },
    ],
    [
      'item-from-each-source-unconfirmed',
      '/?view=library&q=starfall',
      async (p) => {
        await p
          .getByRole('link', { name: /Starfall Academy/ })
          .first()
          .click();
        await p.getByText(/^From each source/).click();
        await p.getByRole('button', { name: 'This is the right book' }).first().waitFor();
      },
    ],
    [
      'item-rating-series',
      '/?view=library&q=starfall',
      async (p) => {
        await p
          .getByRole('link', { name: /Starfall Academy/ })
          .first()
          .click();
        await p.getByRole('link', { name: 'Check and confirm this match' }).waitFor();
        await p.getByText('rating is for the whole series', { exact: false }).waitFor();
      },
    ],
    [
      'item-detail-disagreement',
      '/?view=library&q=glass',
      async (p) => {
        // UI-only invented response; selection and stored facts are covered by app.details.test.ts.
        await p.route('**/api/items/*/online', async (route) => {
          const response = await route.fetch();
          const data = await response.json();
          const years = [1990, 1994].map((year, n) => ({
            value: year,
            source: 'demo',
            sourceId: `invented-year-${n}`,
            label: `Invented source ${n + 1}`,
            reason: 'earliest_trusted_year',
          }));
          data.firstPublishYear = 1990;
          data.details.firstPublishYear = years[0];
          data.details.years = years;
          data.details.yearDisagreement = true;
          data.description =
            'An invented description shown as plain text after removing formatting.';
          data.details.description = {
            value: data.description,
            source: 'demo',
            sourceId: 'invented-description',
            label: 'Invented source 1',
            reason: 'longest_description',
          };
          await route.fulfill({ response, json: data });
        });
        await p
          .getByRole('link', { name: /^Glass Harbor$/ })
          .first()
          .click();
        await p.getByText(/Sources disagree: 1990/).waitFor();
        await p.getByText('Description', { exact: true }).click();
        await p.unroute('**/api/items/*/online');
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
      // Store links: the owner changes a store copy's link (an invented one).
      'item-store-link',
      '/?view=library&q=cartographer',
      async (p) => {
        await p
          .getByRole('link', { name: /Cartographer of Small Rains/ })
          .first()
          .click();
        await p.getByRole('button', { name: 'Change link' }).click();
      },
    ],
    ['library-store-links', '/?view=library&q=cartographer', async () => {}],
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
    // Ratings plan stage 4: the demo never refreshes, so Settings shows an invented status here.
    // Behaviour is covered by app.refresh.test.ts.
    [
      'settings-refresh',
      '/?view=settings',
      async (p) => {
        await p.route('**/api/refresh', (route) =>
          route.fulfill({
            json: {
              enabled: true,
              demo: false,
              paused: false,
              running: false,
              lastCheckAt: '2026-11-11T10:20:00.000Z',
              lastBatch: {
                at: '2026-11-11T10:20:00.000Z',
                books: 9,
                requests: 24,
                bySource: { openlibrary: 9, hardcover: 15 },
                stopped: null,
              },
              dueBooks: 41,
              fresh: null,
              sources: [],
              intervals: { active: 7, open: 30, settled: 90 },
            },
          }),
        );
        await p.route('**/api/lookups/fresh', (route) =>
          route.fulfill({
            json: {
              estimate: { books: 3214, requests: 9642, hours: 2.1, days: 2 },
              snapshot: true,
            },
          }),
        );
        await p.reload();
        await p.waitForLoadState('networkidle');
        await p.getByRole('button', { name: 'Look up all books again…' }).click();
        await p.getByText(/^Look up all 3,214 books again/).waitFor();
        await p.locator('.refresh-settings').scrollIntoViewIfNeeded();
        await p.unroute('**/api/refresh');
        await p.unroute('**/api/lookups/fresh');
      },
    ],
    [
      'item-look-up-again',
      '/?view=library&q=glass',
      async (p) => {
        await p
          .getByRole('link', { name: /^Glass Harbor$/ })
          .first()
          .click();
        await p.getByRole('button', { name: 'Look up again' }).click();
        await p.getByText(/^Looked up again/).waitFor();
      },
    ],
    // M6: Stats, the export section with a full snapshot taken.
    ['stats', '/?view=stats', async () => {}],
    [
      'settings-export',
      '/?view=settings',
      async (p) => {
        await p.getByRole('button', { name: 'Take a full snapshot' }).click();
        await p.getByText(/^Saved in /).waitFor();
        await p.locator('#export-h').scrollIntoViewIfNeeded();
      },
    ],
  ];
  const problems: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, label] of [
      [1280, 'desktop'],
      [390, 'phone'],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      });
      // SHOTS=next,tune takes only those (names start with these).
      const only = (process.env.SHOTS ?? '').split(',').filter(Boolean);
      for (const [name, url, act] of shots) {
        if (only.length && !only.some((o) => name.startsWith(o))) continue;
        await page.goto(BASE + url);
        await page.waitForLoadState('networkidle');
        await act(page);
        await page.waitForTimeout(150);
        for (const x of await audit(page)) problems.push(`${name} (${label}, ${scheme}): ${x}`);
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
  const unique = [...new Set(problems)];
  if (unique.length) {
    console.log(`\nAccessibility checks found ${unique.length} problem(s):`);
    for (const x of unique) console.log(`  - ${x}`);
    process.exitCode = 1;
  } else console.log('Accessibility checks: no problems found.');
} finally {
  server.kill();
}
