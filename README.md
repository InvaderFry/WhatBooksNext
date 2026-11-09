# whatBooksNext

Helps one person choose what to read next from a large, messy collection of ebooks and comics
they already own. It's a local web app for Windows. It lists your folders, works out what each
file is, and tracks your reading with one tap. It isn't a reader: you keep reading in your usual
apps.

**Status: Milestone 2 of 6.** This version has the library and tracking (folders, scanning,
progress, the shortlist, backup and restore) and reads inside your files: titles and authors,
word and page counts, covers, what kind of PDF each one is, and fingerprints that recognise moved
and copied files. Recommendations arrive in Milestone 3.
The full plan is in [`PLAN.md`](PLAN.md), and milestone notes are in
[`docs/milestones/`](docs/milestones/).

## Install and start (Windows)

**👉 Step-by-step guide with screens explained and fixes for common problems:
[INSTALL.md](INSTALL.md).** No programming experience needed.

The short version:

1. Install **Node.js** (the **LTS** version) from <https://nodejs.org>. Leave "Tools for Native
   Modules" unticked; no build tools are needed.
2. Download this repository (green **Code** button → **Download ZIP**) and unzip it somewhere
   that OneDrive doesn't sync, such as `C:\Users\YourName\whatBooksNext`.
3. Double-click **`start-whatBooksNext.bat`**. If Windows says "Windows protected your PC", click
   **More info → Run anyway**.

The first start takes 1–3 minutes, and later starts take a few seconds. The app opens in your
browser at <http://localhost:4818>. Keep the black window open while you use it; closing it stops
the app. No accounts or API keys are needed.

**To try it without your own books**, double-click **`start-demo.bat`**. It opens a clearly
labelled demo library of invented books at <http://localhost:4819>.

## What it does and doesn't do with your files

- **Read-only.** It never renames, moves, changes or creates anything in your library folders.
  Everything it stores goes in the `data` folder next to the app.
- **It never downloads from the cloud by accident.** Files that are online-only (iCloud,
  OneDrive) are never read. Opening one asks you first.
- **A scan has two steps.** First it lists names, sizes and dates, which takes seconds. Then it
  reads inside the files that are on this PC: titles, authors, word and page counts, a cover,
  and a fingerprint (a SHA-256 hash). That step takes longer, runs in the background, and can be
  cancelled; the next scan carries on where it stopped. On an invented 5,000-file test library it
  took about 45 seconds on a 4-core Linux machine. A USB drive on Windows will be slower.
- **Covers and file details are kept in the `data` folder**, never written next to your books.
- **Files are read safely.** Archives are read in memory, never unpacked to disk. Each file has
  limits (60 seconds, 4 GB unpacked, 100:1 compression, 50-megapixel images), so a damaged or
  booby-trapped file is skipped and listed in **Library health** instead of stalling the scan.
- **Your corrections win.** A title, kind or PDF type you fixed is never changed by a scan.
- **Moved files keep their history** when the app can be sure: same name and size, or a
  renamed file with the same fingerprint. When it can't be sure, it asks in **Needs review**
  and changes nothing until you answer.
- **`.zip` and `.rar` files count as comics.** One that turns out not to hold page images is
  left out of the library and listed in Library health.
- **A disconnected drive is skipped, not emptied.** Its books stay in your library, labelled
  "On external drive (not connected)", with all your progress. The app finds the drive again even
  if its letter changes.
- **"Also in iCloud":** if you keep copies of a folder's books in iCloud to read on your iPhone
  or iPad, tick this on the folder in Settings. Its books then count as **Ready to read** even
  while the drive is unplugged. You can override it for any single book.

## Backups

Go to **Settings → Download a backup** for a JSON file of your library, progress, ratings, notes
and settings. It doesn't include book files, cover images or API keys. **Restoring replaces
everything** after showing you a preview and saving a safety copy first. It works without
connecting any drive, and the next scan reconnects the files.

The app also keeps its own safety snapshots in `data/snapshots`: one before each database
update (the last 5) and one before each restore (the last 3).

## Privacy and security

The app listens only on `127.0.0.1`, so other computers can't reach it. It refuses requests
coming from other websites, because a local app without a login could otherwise be triggered by
any web page you visit. **Settings → Diagnostics** gives a copyable report. Folder names are
left out unless you tick the box.

A file's online-only state is checked again just before it's opened, and just before every read
during a scan (details and cover come from one read; the fingerprint, which comes later, is
checked again). A few milliseconds remain
between that check and the read, and that gap is accepted.

Text from files (titles, descriptions) is shown as plain text, never as web page code.

## If it won't start

See **[INSTALL.md → If something goes wrong](INSTALL.md#if-something-goes-wrong)**. It covers
Node.js not being found, install errors ("EPERM"), the port being in use, and a failed database
update. Updating and uninstalling are covered in [INSTALL.md](INSTALL.md) too.

## For developers

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the API on port 4818 and Vite on <http://localhost:5173>.

```bash
npm test
```

The other checks are `npm run typecheck`, `npm run lint` and `npm run format:check`. CI runs all
four on Ubuntu and Windows.

`npm run screenshots` drives the demo library in Chromium and saves screenshots to
`screenshots/`. It needs Playwright, which isn't a dependency. `npm run benchmark` times a
scan of 5,000 generated files and how quickly the app answers during it.

Reading files uses pdf.js (`pdfjs-dist`) for PDFs, `@napi-rs/canvas` to draw covers, `yauzl`
for ZIP-based files and `node-unrar-js` (WebAssembly) for RAR. None needs a compiler or an
install script.

The server is TypeScript run directly by Node (type stripping), so it has no build step. The
stack is Express, better-sqlite3, React and Vite, with no ORM, router, state library or CSS
framework. Windows-specific code sits behind `server/src/platform/`, which has a fake for tests.

## Licence

[PolyForm Strict 1.0.0](LICENSE). You may read the code and run it for yourself. You may not
change or redistribute it. Third-party notices are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
