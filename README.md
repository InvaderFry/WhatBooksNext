# whatBooksNext

Helps one person choose what to read next from a large, messy collection of ebooks and comics
they already own. It's a local web app for Windows. It lists your folders, works out what each
file is, and tracks your reading with one tap. It isn't a reader: you keep reading in your usual
apps.

**Status: Milestone 1 of 6.** This version has the library and tracking: folders, scanning, the
library, progress, the shortlist, and backup and restore. Recommendations arrive in Milestone 3.
The full plan is in [`PLAN.md`](PLAN.md), and milestone notes are in
[`docs/milestones/`](docs/milestones/).

## Install and start (Windows)

1. Install **Node.js 24 or newer** (the "LTS" download from <https://nodejs.org>).
2. Download this repository (green **Code** button → **Download ZIP**, then unzip) or clone it.
3. Double-click **`start-whatBooksNext.bat`**.

The first start installs dependencies and builds the pages, which takes a minute. Later starts
take a few seconds. The app opens in your browser at <http://localhost:4818>. Keep the window
open while you use it, and close it (or press Ctrl+C) to stop.

No accounts or API keys are needed.

**To try it without your own books**, run `npm run demo` from a Command Prompt in this folder.
It opens a clearly labelled demo library where every title is invented.

## What it does and doesn't do with your files

- **Read-only.** It never renames, moves, changes or creates anything in your library folders.
  Everything it stores goes in the `data` folder next to the app.
- **It never downloads from the cloud by accident.** Files that are online-only (iCloud,
  OneDrive) are never read. Opening one asks you first.
- **Scanning lists names, sizes and dates only** in this version. Reading inside files arrives in
  Milestone 2.
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

A file's online-only state is checked again just before it's opened. A few milliseconds remain
between that check and the open, and that gap is accepted.

## If it won't start

- **"Node.js is not installed" or "needs Node.js 24 or newer":** install the LTS version from
  <https://nodejs.org> and try again.
- **"Port 4818 is already in use":** the app is probably already running in another window. If
  something else uses that port, run `set PORT=4819` and then `start-whatBooksNext.bat` in a
  Command Prompt.
- **"The database couldn't be updated":** nothing was changed. The message names the snapshot
  saved just before the update and says how to put it back.

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
`screenshots/`. It needs Playwright, which isn't a dependency.

The server is TypeScript run directly by Node (type stripping), so it has no build step. The
stack is Express, better-sqlite3, React and Vite, with no ORM, router, state library or CSS
framework. Windows-specific code sits behind `server/src/platform/`, which has a fake for tests.

## Licence

[PolyForm Strict 1.0.0](LICENSE). You may read the code and run it for yourself. You may not
change or redistribute it. Third-party notices are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
