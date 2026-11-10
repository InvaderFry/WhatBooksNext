# whatBooksNext

Helps one person choose what to read next from a large, messy collection of ebooks and comics
they already own. It's a local web app for Windows. It lists your folders, works out what each
file is, and tracks your reading with one tap. It isn't a reader: you keep reading in your usual
apps.

**Status: Milestone 5 of 6 — all ten modes and taste learning built; Windows checks remain.**
This version has the library and tracking (folders, scanning, progress, the shortlist, backup and
restore), reads inside your files (titles, authors, word and page counts, covers, fingerprints
that recognise moved and copied files), looks your books up online for ratings and details, and
**What next** suggests what to read in ten different ways, with the reasons behind each pick.
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

## Recommendations and online lookups

**What next** ranks the books you own and haven't finished. Choose how long you have, and whether
you want to _read for_ that long or _finish something_ in that time. Each pick says what it is
("Whole book · ~4–5 h"), why it was picked, and what it rests on less firmly ("rough length",
"unconfirmed match", "on external drive (not connected)"). **Not this, because…** on any card
tells the app why not. **What kind?** narrows the picks to Books, Tech, Comics and manga, or All.
When a book has several files, it opens EPUB first; a comic opens PDF, then CBZ, then EPUB (an HD
copy first). Every file keeps its own Open button on the book's page. **Triage** sorts books into Want / Maybe / Never / Already read; it's
optional. It can take just the **new arrivals** from your last scan, or **one folder**, and can
mark **several at once** as Already read or Never, with a preview first and Undo after.

**The ten modes.** _What are you after?_ on What next switches between them. Each states its rule
on screen, and none ever shows a finished, Never, hidden or "did not finish" book:

| Mode                  | What it shows                                                                      |
| --------------------- | ---------------------------------------------------------------------------------- |
| Read next             | The best picks for the time you have                                               |
| Continue reading      | Books you've started: your shortlist first, then nearly done, halfway…             |
| Next in series        | The next book you own in each series you've started; an earlier skipped one first  |
| One-sitting reads     | Whole books or single installments whose measured length fits (2 hours by default) |
| Waiting on your shelf | Highly rated, unstarted, the ones you've had longest first                         |
| Hidden gems           | Highly rated with few ratings for their source (a missing count isn't "obscure")   |
| Classics you missed   | Highly rated, unstarted, first published 25+ years ago                             |
| Still relevant?       | A review of undecided tech books: Want, Mark as reference, Never or Decide later   |
| Mood                  | Escape, Learn or Skim: moves matching books up without hiding the rest             |
| Surprise me           | A random pick from your top 50, favouring the top; Reroll and Not today            |

**Complete stories only** keeps standalone books and finished series you own every part of. Under
**Settings → Topic interests** you can list subjects ("Rust", "gardening"); What next can then show
one topic (reference books included). **Still reading?** gathers books untouched for three months
into one list — Still reading, Snooze 30 days, Back to not started, or Did not finish.

**Taste and Tune.** Once you've rated, finished or stopped ("Not for me") ten books from at least
three different authors or series, whatBooksNext learns which genres, authors, comic artists and
publishers stand out for you, and the card says so ("You rate books by … highly"). Until then it
changes nothing, and one series counts as at most two books. **Settings → Tune** shows how much
each part of the ranking counts, with a Reset, the taste strength (Off / Low / Normal / High) and
what it has learned. A caveat: taste tends to suggest more of what you already read — turn it down
if picks feel samey.

**Series.** Books in a series are offered one at a time: the one you're reading, else the next
unread one. The series comes from the files' own details (EPUB series, ComicInfo), or from a source
once the match is certain. If a number is missing ("you own volumes 1, 2 and 4"), the card says
so **before you start**: _Gap ahead: volume 3 isn't recorded as owned or read._ You can carry on
anyway, say you read it elsewhere (it fills the gap, is never recommended, and adds no finish
date), or fix the series on the book's page. There you can also correct a book's series or number,
take it out of a series, and say whether the story is finished. Single comic issues only count
gaps between issues you have, because issue runs often start part-way. A collected edition (a
trade paperback) can say which issues it holds — you type it in on its page under **Collects**, or
Metron suggests it and you confirm. Once confirmed, it fills those issue gaps, and finishing it
counts its issues as read (once: nothing is added to the issues' own progress).

To rank books, whatBooksNext looks them up online. Only titles, authors and ISBNs are sent —
never files or your reading history.

| Source       | Key                 | Used for                                                |
| ------------ | ------------------- | ------------------------------------------------------- |
| Open Library | none                | books: ratings (some), subjects, first publication year |
| AniList      | none                | manga: series scores, genres, publication status        |
| Hardcover    | optional free token | book ratings with vote counts, series, genres           |
| Metron       | optional free token | single comic issues: series, run, cover year, ended?    |
| ComicVine    | optional free key   | comic issues Metron can't find (200 requests an hour)   |

Everything works without a key. Lookups run after each scan (you can turn that off in
**Settings → Online lookups**), about one book a second, and pick up where they stopped. **Sources
fail soft:** if one is down or refuses requests, it's paused for ten minutes after five failures
in a row, the rest carries on, and nothing already found is lost. Western comics have almost no
community ratings anywhere. Single comic issues are looked up only on Metron (and ComicVine, when
Metron finds nothing), so without those keys they rank on your own signals. An issue is matched by
series name and number; a year in the file (the filename's "(2019)" or ComicInfo's Year) that
agrees with the issue's makes the match certain, so two runs with the same name aren't confused.

When a match isn't certain, the book is still recommended, marked "unconfirmed", and listed in
**Needs review**, where you can confirm it, pick another, search, or leave it unidentified. Your
answers always win over later lookups. A book with no rating or length counts as average, never
last.

**Hardcover token:** make a free account at hardcover.app, then create a token in its account
settings with only the "read catalog" permission (Settings links straight to that form). Paste
it in **Settings → Online lookups**. It stays on this PC: it's never in a backup, an export or the
Diagnostics report. Then press **Diagnostics → Test Hardcover**.

## Store books, spreadsheets and Calibre

- **Store books** (Kindle, Apple Books, Google Play, Kobo, GlobalComix): Library → **Add a store
  book…**, found online or typed in. They're recommended like any book, labelled "In Kindle"
  and so on, and count as ready to read once you tick "I can read it there now".
- **A spreadsheet of store books:** Settings → **Store books from a spreadsheet**. A CSV with the
  columns `title, author, store, kind, progress, isbn, series, series_index, rating, note` (only
  `title` is needed). You see what would happen first; importing the same file again adds
  nothing twice and never overwrites your edits.
- **Calibre:** Settings → **Calibre**. Paste your Calibre library folder. The app reads a copy of
  Calibre's `metadata.db` and changes nothing in Calibre. Your ratings and a "read" column come
  across only if you choose them.

## Goodreads and StoryGraph reading history

Settings → **Reading history from Goodreads or StoryGraph** previews your exported CSV before
saving anything. Choose the service and its file. Matches by ISBN also need an agreeing title
or author; possible title matches require your confirmation. Existing progress, ratings, dates
and notes are kept. Re-importing the same books changes nothing, including after a backup restore.

Unmatched read, reading and DNF books can become **history-only** entries: they never appear in
recommendations. Unmatched to-read books are skipped, and an export's ownership column does not
add a store copy. DNF history does not imply a dislike reason. Ratings out of 5 are doubled;
StoryGraph quarter stars are rounded to our whole-number 1–10 scale, with the conversion shown.
Missing dates stay unknown, partial dates stay approximate, and upload dates are never substituted.
Reviews and Goodreads private notes become notes. Rereads are represented by one reading and the
last finish date; other export columns are ignored.

Compatibility is checked against [public sample layouts](fixtures/imports/README.md).
A fresh authenticated export from each service still needs a real-user check.

## Backups

Go to **Settings → Download a backup** for a JSON file of your library, progress, ratings, notes
and settings, including your answers in Needs review and the matches found online. It doesn't
include book files, cover images, API keys or the raw responses from online sources. **Restoring replaces
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
scan of 5,000 generated files and how quickly the app answers during it. `npm run
report:matches` runs the matching over labelled examples (recorded source responses, no network)
and reports precision and wrong high-confidence matches.

Online sources are built against recorded responses in `fixtures/sources/`. The demo
(`DEMO=1`) never goes online: it uses an invented source for its invented books.

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
