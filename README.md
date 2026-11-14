# whatBooksNext

Helps one person choose what to read next from a large, messy collection of ebooks and comics
they already own. It's a local web app for Windows. It lists your folders, works out what each
file is, and tracks your reading with one tap. It isn't a reader: you keep reading in your usual
apps.

**Status: version 1 (Milestone 6 of 6) — feature-complete; a few Windows behaviours are still
to be confirmed on a real PC (listed under [Limitations](#limitations)).** It lists your folders,
reads inside your files (titles, authors, word and page counts, covers, fingerprints that
recognise moved and copied files), looks your books up online for ratings and details, and
**What next** suggests what to read in ten different ways, with the reasons behind each pick.
**Stats** shows what you've read and what's waiting. The full plan is in [`PLAN.md`](PLAN.md),
and milestone notes are in [`docs/milestones/`](docs/milestones/).

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

**Saved views.** Once What next shows the choices you want ("30 min", "Comics and manga", "Ready
to read only"), press **Save these choices…** and give them a name, such as "30-minute comics,
ready now". The name then appears as a button above the choices: one tap brings them all back.
**Edit saved views** removes one. You can keep up to 12, and they're included in backups. On a
narrow screen the choices fold into one line ("Showing Read next · 30 min · …") with a **Change**
button, and the Library's filters fold behind **Filters and sort**, so books start near the top.

**Why isn't a book here?** At the foot of What next, find any book to see what keeps it out of
the list as it stands. For example: it's finished or marked Never, "What kind?" is set to Books, an
earlier book in its series comes first, or its length won't fit the time chosen. Each reason has a
button that makes the change for you, such as **Show all kinds**, or opens the book that comes
first. Nothing is loosened behind your back. A book's own page has the same check for Read next
under **In What next?**.

**Series page.** **Series** in the menu lists every series, the ones you're reading first. For
each it shows what you own, have read and are reading, how many are missing (published volumes
you don't have, and gaps), and the one to read next. **With gaps** narrows the list. A series'
own page shows its full order with the same actions as a book's Series section: finished or
ongoing, "I read these elsewhere", and confirming what a collected edition holds. A book's Series
section links to it with **See the whole series**.

**The ten modes.** _What are you after?_ on What next switches between them. Each states its rule
on screen, and none ever shows a finished, Never, hidden or "did not finish" book:

| Mode                  | What it shows                                                                      |
| --------------------- | ---------------------------------------------------------------------------------- |
| Read next             | The best picks for the time you have                                               |
| Continue reading      | Books you've started: your shortlist first, then nearly done, halfway…             |
| Next in series        | The next book you own in each series you've started; an earlier skipped one first  |
| One-sitting reads     | Whole books or single installments whose measured length fits (2 hours by default) |
| Waiting on your shelf | Highly rated, unstarted, the ones you've had longest first                         |
| Hidden gems           | Highly rated trusted books/volumes with few ratings everywhere checked             |
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

The community rating comes from a trusted match (confirmed by you or accepted by the app),
with scope first, then the most ratings. A supported book/volume rating (at least 20 ratings)
comes before a supported whole-series score, then sparse book/volume and sparse series scores.
An unconfirmed match is a labelled last resort. Counts from different sites are never added,
and each series rating counts once in its source's statistics. Your personal rating still
replaces the community part of the ranking. In the Library, **Your rating** sorts by your own
ratings, and **Online rating** sorts by the chosen online rating, adjusted for how many people
rated it, with unrated books last.
**Hidden gems** needs at least 3 ratings on a trusted book/volume match, a score at its source's
"highly rated" line, and few ratings (25 or fewer, or the bottom half for that source in your
library) there and on every other trusted source with a known count. Unknown counts don't prove
obscurity.
**Diagnostics → Rating evidence** shows the five tier counts and how many default What next
picks use an unconfirmed rating. CSV export appends `community_scope` and `community_match`.

**Details from stored matches.** Your title wins, then Calibre's, then the file's own title,
then a trusted online match, then the filename. Creators use Calibre, the file, then a trusted
source. The app uses the earliest trusted publication year; a single issue keeps its own cover
or store year. The book page names sources when years disagree by more than a year. Measured
pages beat source estimates, and a match to the file's ISBN beats other source page counts.
Descriptions lose HTML/formatting before comparison: a useful Hardcover description wins,
otherwise the longest trusted one. Displayed subjects list their trusted/file sources.
Unconfirmed matches never supply these facts; they remain under Possible matches. These choices
need no new lookups or rescan and don't change matching, kind guesses or taste/topic inputs.

Everything works without a key. Lookups run after each scan (you can turn that off in
**Settings → Online lookups**), about one book a second, and pick up where they stopped. **Sources
fail soft:** if one is down or refuses requests, it's paused for ten minutes after five failures
in a row, the rest carries on, and nothing already found is lost. Western comics have almost no
community ratings anywhere. Single comic issues are looked up only on Metron (and ComicVine, when
Metron finds nothing), so without those keys they rank on your own signals. An issue is matched by
series name and number; a year in the file (the filename's "(2019)" or ComicInfo's Year) that
agrees with the issue's makes the match certain, so two runs with the same name aren't confused.

**Ratings stay current on their own.** While the app is open it asks the sources again now and
then, in small batches: every 7 days for books you're reading or have shortlisted, every 30 days
for books still without a rating many people agree on, and every 90 days for the rest. It uses at
most a fifth of Hardcover's and Metron's daily allowance, waits during scans and lookups, and keeps
a book's previous answer when a source fails or no longer finds it clearly. It never switches a
match on its own: if a source now prefers another record, **Needs review** asks you ("Check this
match"). Turn it off, pause it or run it now in **Settings → Online lookups → Keeping ratings up to
date**. **Look up again** on a book page, and **Look up all books again** in Settings, ask every
source afresh and let the app choose its matches again; your confirmations, rejections and edits
always stay.

When a match isn't certain, the book is still recommended, marked "unconfirmed", and listed in
**Needs review**, where you can confirm it, pick another, search, or leave it unidentified. Your
answers always win over later lookups. Needs review shows **Your copy** above the choices:
its filename, embedded title and publisher, detected years, creators, and cached cover when
available. Candidate cards show the publisher when the source supplies it. **Match score** is
for comparing candidates, not a percentage confidence. Tied comic runs explain why the available
evidence could not distinguish them.

**Compare pages and covers.** In Needs review or a book's **Ratings and details**, expand
**Your copy: first two pages**, then press **Generate page previews**. PDFs and CBZ/CBR comics
show their first two physical pages/images in reading order. EPUBs show their first two opening
spine sections, using embedded pictures or a simplified text layout; EPUBs have no fixed page
numbers. Choose a local file when the book has more than one. Click a page or source cover to
enlarge it; Escape or **Close image** returns to the comparison. On wider screens, opening
pages sit beside the candidate covers.

Previews are generated on demand in a worker, go through the same fresh file-attribute check
and limits as scanning, and are cached under `data/page-previews`. Online-only files aren't
downloaded; connect the drive or download the file in its cloud app first. Cached previews can
be viewed with the drive disconnected and are invalidated when a scan records changed file
facts. They are disposable and aren't included in backups or full snapshots. Store/history
imports without local files have no local pages; their online covers can still be compared.
Formats that scanning only lists by name (such as CB7) don't gain page previews.

Candidate covers from Hardcover, Metron, ComicVine, Open Library and AniList appear when the
source supplies a supported public image URL. Images load from the source's image host in the
browser, with no referrer; your files are never uploaded. A source's cover can represent a
different edition (or a whole series), so visual similarity never confirms a match automatically.
Older stored candidates may need **Look up again** to obtain their cover URLs.

**Covers for books without one in the file** (store books, reading history) come from the book's
own match, but only one you confirmed or the app accepted: a wrong picture would be worse than
none. The picture is saved in the `data` folder. If it's the wrong one, press **Wrong cover?**
under it on the book's page; the app then tries the book's other confident matches, and **Show
online covers again** undoes it. **Diagnostics** shows how many covers are waiting, with **Get
covers now**.

These display changes make reviews easier; restarting alone does not settle an ambiguous match.
For older candidates missing publisher details, use **Look up again** on the book's page (or
**Settings → Online lookups → Look up all books again**). Confirming the right candidate clears
its identity review and remains your choice on later lookups. A book with no rating or length
counts as average, never last.

**Hardcover token:** make a free account at hardcover.app, then create a token in its account
settings with only the "read catalog" permission (Settings links straight to that form). Paste
it in **Settings → Online lookups**. It stays on this PC: it's never in a backup, an export or the
Diagnostics report. Then press **Diagnostics → Test Hardcover**.

**Metron token** (for single comic issues): make a free account at metron.cloud, create an API
token on your account page, and paste it in **Settings → Online lookups → Metron**. Then press
**Diagnostics → Test Metron**. **ComicVine key** (a slower fallback, 200 requests an hour, for
non-commercial use): make a free account at comicvine.gamespot.com, copy your API key from its
API page, paste it under **ComicVine**, and press **Diagnostics → Test ComicVine**. Like the
Hardcover token, these stay on this PC.

## Store books, spreadsheets and Calibre

- **Your store purchases** (Kindle, Google Play Books, Kobo, GlobalComix): Settings → **Import
  store purchases**. Drag that store's **bookmark button** to your browser's bookmarks bar once.
  Then open the store's own library page, signed in as usual, and click the bookmark. It reads
  the list the page shows, slowly, and saves a file to your Downloads folder. whatBooksNext never
  contacts the store and never sees your password. Choose that file in Settings to see a preview
  before anything is added:
  - samples, subscription reads (such as Kindle Unlimited), loans, your own uploads and documents
    are left out;
  - books the store wasn't clear about are listed under "Not sure these are yours" for you to
    tick;
  - running it again later adds only new purchases. A book that's no longer found goes to
    **Needs review**, never deleted, and a scan that finds far fewer books than last time asks you
    first.

  When whatBooksNext is updated, drag the bookmark again so you have the newest version. If you
  can't use a bookmark, the same steps offer a script to paste into the browser's console. Apple
  Books has no web library, so its books are added as below.

- **One store book at a time** (any store, including Apple Books): Library → **Add a store
  book…**, found online or typed in. Store books are recommended like any book, labelled "In
  Kindle" and so on, and count as ready to read once you tick "I can read it there now". The
  Library's **Store** filter shows one store's books.
- **Read links:** a store book can keep a link to where you read it ("Read in Kindle ↗"). It
  opens in your browser and becomes the main action on the book's page when no file is here.
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

## Stats

**Stats** keeps facts apart from estimates. The facts are what you marked and what your files
say: books finished each year (this year so far against last year by the same date), how much of
each kind and each folder you've read ("12 of 340"), why you stopped books, how many you marked
Never, your ratings, what taste has learned, your takeaways, and how many books have a rating, a
length and a series. A book finished on a date you didn't record is listed apart and counted in
no year. The **estimate** is the reading time of your backlog: it adds up only the books whose
length is known, and says how many that is. Never and reference books stay out of the backlog.

## Backups, snapshots and export

Go to **Settings → Download a backup** for a JSON file of your library, progress, ratings, notes
and settings, including your answers in Needs review and the matches found online. It doesn't
include book files, cover images, API keys or the raw responses from online sources. **Restoring replaces
everything** after showing you a preview and saving a safety copy first. It works without
connecting any drive, and the next scan reconnects the files.

The app also keeps its own safety snapshots in `data/snapshots`: one before each database
update (the last 5) and one before each restore (the last 3).

**Settings → Export and snapshots** has two more:

- **Take a full snapshot** saves a complete copy of the app's data — everything in a backup plus
  the cover images and the details found online — in a new folder under `data/full-snapshots`
  (the newest 3 are kept). API keys are left out. Its `README.txt` says how to go back to it.
- **Download as CSV** gives one row per book for Excel or Google Sheets: your progress, dates,
  rating, notes, series, where it is, and what was found online. It's not a backup and can't be
  restored. Dates you didn't record stay empty.

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

## Updating

1. **Settings → Download a backup**, just in case.
2. Close the black window.
3. Download and unzip the new version into a **new** folder, and copy the `data` folder from the
   old one into it.
4. Double-click `start-whatBooksNext.bat`. It installs what the new version needs, and before the
   database is changed it saves a safety copy in `data\snapshots` (`pre-migration-…`).

(Developers with a clone: `git pull`, `npm install`, `npm run build`, `npm start`.) Details:
[INSTALL.md → Updating](INSTALL.md#updating-to-a-new-version).

## If it won't start

The black window always says why. The usual causes:

- **Node.js missing or too old.** Install the current LTS from <https://nodejs.org> (version 24
  or newer), then start again. Restart the PC if Windows still can't find it.
- **Port 4818 in use.** whatBooksNext may already be running in another window. Otherwise start
  it on another port (`set PORT=4820`, then `start-whatBooksNext.bat`).
- **"The database couldn't be updated."** Nothing was changed. The message names the safety copy
  saved just before (`data\snapshots\pre-migration-v…-….sqlite`). To go back: close the window,
  replace `data\whatbooksnext.sqlite` with that file (delete `whatbooksnext.sqlite-wal` and
  `-shm` if they're there), and run the previous version of the app. Then ask for help with the
  message and the Diagnostics report.
- **Install errors ("EPERM").** Something (often OneDrive or antivirus) holds the app's files.
  Delete the `node_modules` folder and start again, or move the app out of a OneDrive folder.

Step-by-step versions of all of these are in
**[INSTALL.md → If something goes wrong](INSTALL.md#if-something-goes-wrong)**.

## Performance

Measured with `npm run benchmark`: 5,000 generated files (40% EPUB, 30% PDF, 20% CBZ, 10% MOBI)
on a 4-core 2.1 GHz Linux machine with 16 GB and a local disk.

| Step                             | Time                                |
| -------------------------------- | ----------------------------------- |
| Listing (names, sizes, grouping) | 2.8 s                               |
| Reading inside the files         | 40 s                                |
| Fingerprinting and finishing     | 14 s                                |
| Rescan with nothing changed      | 4.7 s                               |
| What next / Stats                | 147 ms / 272 ms                     |
| Library page while a scan runs   | median 40 ms, 95th percentile 64 ms |

These aren't Windows or USB-drive numbers, and the test files are small. Real comics are tens or
hundreds of megabytes, and fingerprinting reads every byte, so a first scan of a large USB drive
can take an hour or more. It runs in the background, last, and carries on after a cancel.

## Limitations

- **Windows only, for now.** Mac and Linux should mostly work but are untested.
- **Needs checking on a real Windows PC** (built and tested against a stand-in): a drive letter
  changing, iCloud or OneDrive files downloading while the app watches, and Open / Show in folder
  on every kind of file. Diagnostics shows whether the last Open worked.
- **Ratings are thin without keys**, and Western comics have almost none anywhere.
- **Reading times are estimates**: assumed reading speeds, give or take 20%.
- **Taste learning** tends to suggest more of what you already read (see Tune).
- **Store purchase imports** depend on each store's web page. If a store changes its page, its
  bookmark may stop working or find fewer books until whatBooksNext is updated; the preview
  warns you before anything changes. Apple Books can't be imported this way. Kindle Unlimited,
  Prime and loan labels haven't been seen on a real account yet, so check the preview the first
  time you import while borrowing one.
- **Goodreads and StoryGraph imports** are checked against public sample layouts, not yet against
  a fresh export from each service.

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

### Identifying Humble books with missing metadata

On a book’s page, open **Ratings and details → Identify using bundle details and opening pages**.
Save the Humble bundle name, a purchase/bundle/publisher link, title, creator, ISBN, and evidence
or edition uncertainty. These notes are included in backups and do not confirm or replace a match.
Choose **Use these details in search**, select a source, then **Search** and compare the candidates
and covers before confirming. Open Library supports ISBN searches; other catalogs vary.

After the next scan, the panel also shows cached text from the first ten text-PDF pages (four for image-heavy PDFs) or first six
non-navigation EPUB sections (up to 6,000 characters each), plus ISBN clues (EPUBs are also
checked for a copyright page in their last three sections). Unresolved automatic Open Library lookups try up to three printed ISBNs,
checking the results against the original file facts. This includes opening
PDF pages even when the rest of a comic has no text layer. Text stays local; only the title, author
and ISBN entered in search go to catalogs. Copy distinctive text for a manual publisher-preview
search when necessary. Image-only pages still require visual inspection; OCR and automatic Humble
account imports are not included. Existing confirmed matches remain yours to change.
