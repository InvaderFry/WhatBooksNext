# whatBooksNext — Project Plan (v4)

The handoff document for the AI agent starting this project in a new, empty repository. It is
standalone: it replaces every earlier version (the original plan, the revised plan and v3), and you
don't need any of them.

Read it all before writing code. It says what to build, in what order, and why — including decisions
the owner has already made, so they don't get reopened.

Written November 2026. Nothing here has been built yet. Facts about outside services were checked
when written but change; anything marked **verify** must be rechecked before you rely on it. Every
tunable number lives in **§20 Starting values**, labelled as an assumption with its reason.

---

## 1. What changed

### From v3 to v4

From a third review, all approved by the owner. Most are short rules added to existing sections.

| Area | v4 change | Why |
| --- | --- | --- |
| **Milestone 0** | A read-only Windows probe (a `.bat` that writes a plain-text report) runs on the owner's PC before M1. Its checks later become **Settings → Diagnostics** (§15). | Settles the riskiest assumptions — iCloud placeholders, drive identity, real filenames — before anything is built on them. Running it needs no AI, so any user can check their own setup. |
| **Recommendation quality** | Owner sessions after M3 and M6 (§17.2), plus a **"Not this, because…"** action on cards (§13.8). | Tests prove the app is *correct*; only the owner can say whether its picks are *good*. |
| **Zero-key experience** | Data coverage shown by kind; behaviour when ratings are missing stated; **Hardcover shown as Recommended** in setup and verified early; its adapter moves to M3. | Keyless book ratings are thin and Western comics have none. |
| **Collections ↔ issues** | Defined rules for shared reading state; every reading counted once (§12.5). | Prevents double-counting and contradictory states. |
| **Time fit** | One rule for what counts as a confident fit (§12.3). | Avoids an invented confidence model. |
| **Identity edge cases** | Format trios auto-group; ties; edition numbers; unknown language; undo after later edits (§11.2–11.4). | Under v3, every Humble EPUB+PDF+MOBI trio would have landed in the review queue. |
| **Review load** | Tiered queue with Defer and Dismiss (§11.4). | The queue must not become a second backlog. |
| **Security and operations** | Localhost request checks, safe rendering of descriptions, archive and memory limits, a backup-coverage test, update and troubleshooting docs (§6.3, §16, §18 M6). | A login-free local app can otherwise be triggered by any website the owner visits. |
| **Smaller rules** | Continue-reading order, file-date acquisition, Surprise me weighting, taste threshold diversity, Still-reading digest, Complete-stories definition, repeat CSV imports, side stories. | Each closed an ambiguity the review found. |
| **Audience** | v1 is for people comfortable installing Node and running a command. An easy installer and Mac/Linux support are on the roadmap (§19). | Keeps v1 achievable. |

### From the revised plan to v3

v3 kept the revised plan's corrections and the owner's answers, and changed the following:

| Area | Revised plan | v3 | Why |
| --- | --- | --- | --- |
| Editions | A separate Editions entity | Edition details recorded on each file; files that differ in language or abridgment are **never merged automatically** | Prevents the real harm (mixed lengths and progress) without a table that every query, merge and backup must handle. Converts to a full entity later if needed. |
| Collected-edition coverage | Evidence and confidence per covered issue | Simple issue ranges, **suggested** or **confirmed**, with manual entry | No source reliably provides this data; a scoring system for absent data is wasted work. |
| Data provenance | Every field with source, date, confidence and scope | Raw source responses cached; source recorded for the fields that drive ranking | Explains wrong values and lets matching be re-run from cache without re-fetching from rate-limited APIs. |
| Merge/split undo | Full reversible edit history | Undo stack for the last 20 merges/splits; id aliases kept | Covers real cleanup sessions at a fraction of the cost. |
| M1 | Included a basic "Read next" | Ends at library, progress, shortlist and backup. Recommendations arrive once keyless lookups exist (M3). | A ranking with no ratings or lengths behind it is effectively random and demonstrates nothing. |
| Starting values | Removed in favour of "calibrate" | Restored as labelled assumptions with reasons (§20) | The agent has to pick numbers on day one; better reasoned than invented. |
| Continue reading | Ordered mainly by recent activity | "Nearly done" first, then by recent activity | Nudging you to finish what you're close to is the point of the mode. |
| Time budget | Two controls | One time control with a **Read for / Finish within** switch | Same distinction, simpler screen. |
| Mode name | "Older favorites" | **"Classics you missed"** | "Favorites" implies books already read; this mode is about unread ones. |
| Style | Dense, caveat-heavy | Direct: "do this, because…" | Pages of caveats lead agents to over-build safeguards and under-build features. The caution that matters is kept as rules. |

---

## 2. What this is

**whatBooksNext helps one person choose what to read next from a large, messy collection of ebooks
and comics they already own.**

It is a local web app. It scans the folders where the owner's EPUBs, PDFs and comic archives live,
works out what each file is, looks up ratings, lengths and series information, ranks the
to-be-read pile in several ways, and tracks progress with one tap. Books that can only be read in a
store's app (Kindle, Kobo, GlobalComix) are added by search or CSV so the ranking covers everything.

**It is not a reader and not a library server.** The owner reads in other apps.

**Backlog first.** The owner wants to read what they already own before buying more. Recommendations
are always owned (or otherwise accessible) books. Buying or subscribing to fill a missing
installment is the owner's choice; the app never ranks by it and has no shopping features.

It is the sibling of **whatGamesNext** (`github.com/InvaderFry/whatGamesNext`), which does the same
job for games. If you can read that repo, skim its `README.md` and `ROADMAP.md` for tone and habits.
Copy patterns, not code — this is a new repo with no shared package. The games app was a starting
point, not a template every name must match.

## 3. The owner

- Runs the app on a **Windows PC**. Reads mostly on an **iPhone and iPad** in Apple Books,
  PocketBook, the Kindle app and others. No e-reader.
- **A few thousand files**: fiction, nonfiction, self-help, tech books, Western comics, manga,
  reference books. Many from Humble Bundle, so filenames are often run-together lowercase slugs.
- **Storage:** an external drive that isn't always connected, and **iCloud Drive for Windows**
  (some files downloaded, some online-only).
- **A handful of store-locked titles** in Kindle, Kobo and GlobalComix.
- **No reading history to import** — but Goodreads and StoryGraph import must exist for other users.
- **Updates progress on the PC** now and then. Phone access can wait for the Cloud release.
- Real filenames to test with: `boatofamillionyears.epub`, `shadowservice_vol1_darkarts.pdf`
  (very likely a comic delivered as a PDF). **More samples after M1 — ask for them.**

## 4. Decisions already made

| Decision | Rule |
| --- | --- |
| **Local-only v1** | Bound to `127.0.0.1`. Remote access is the Cloud release (§19), but v1 must be built so it can be added without a rewrite (§6.5). |
| **Folders only** | No Humble Bundle account import. |
| **Read-only on the library** | Never rename, move, tag, modify or create files (not even a marker file) in library folders. All app writes go to the app's data folder. |
| **Never trigger a cloud download by accident** | Online-only or uncertain files are never read. Opening one is allowed only after the owner confirms. |
| **Manual scans** | A "Scan now" button. No scheduled scans. A reminder per folder after 30 days without a complete scan. |
| **Comics** | Recommend a series run (its next issue); track individual issues. |
| **One-tap progress** | Buckets, never required percentages or page numbers. |
| **All ten modes in v1** | Earlier milestones are steps toward v1, not a smaller substitute for it. |
| **Useful with zero API keys** | Keys improve coverage; nothing requires them. |
| **Honest about what's unknown** | Unknown data scores neutral in the general blend, shows as **?** or "unknown", and never passes a filter that asks for a known value. |
| **Owner corrections win** | Scans and lookups never overwrite a confirmed match, a rejected candidate or an override. |
| **Cautious matching** | An unidentified book is better than history attached to the wrong one. |
| **Same stack as whatGamesNext** | Express, better-sqlite3, React, Vite, TypeScript, npm workspaces. |
| **Audience for v1** | The owner and other people comfortable installing Node and running one command. A double-click installer is on the roadmap. |
| **Windows first** | Windows is supported and tested. Mac and Linux should mostly work through fallbacks but are untested in v1; proper support is on the roadmap. |

Owner answers that shape the product (from the plan reviews):

- **Two time intentions:** "Read for 30 minutes" (a session) differs from "Finish within 30 minutes"
  (a whole work). Both are supported.
- **Series gaps:** warn clearly on the recommendation card, *before* the owner starts a series, but
  still allow continuing.
- **Unavailable files stay recommendable**, with a label. A "Ready to read" filter exists.
- **Did not finish** excludes a book until restored, with optional reasons: Not for me / Not now /
  Too difficult right now. Only "Not for me" counts as dislike.
- **Already read** takes one tap; rating and date are optional, and an unknown date stays unknown.
- **Triage is offered, not forced:** a short optional session, Skip and Undo, bulk actions,
  recommendations available immediately.
- **Tech books:** a relevance review, not an age-based urgency list. Old fundamentals aren't stale.
- **Recommendation check:** the owner will do a ~20-minute session judging real picks after M3 and
  again at M6 (§17.2).
- **Hardcover:** shown as **Recommended** (optional, skippable) in setup — but only after it's been
  verified to work for this use (§12.1).
- **Milestone 0 probe:** the owner will run it if needed. It must work without any AI involved.

## 5. How to work on this codebase

Carried over from whatGamesNext, where each was learned the hard way.

- **Keep the architecture plain.** No ORM, no state library, no CSS framework, no router; URL state is
  a small helper. Add a dependency only when it clearly earns itself, and say why in the commit.
- **Comments say _why_, not _what_.** Every non-obvious constant explains its value. Constants come
  from §20 and say so.
- **Unknown is neutral, never zero.** An unrated book scores mid-range, not last.
- **Never fabricate.** No invented ratings, ids, dates or lengths for real works — including in demo
  mode.
- **Flaky sources fail soft**, with a circuit breaker after repeated errors. The README names them.
- **Tests read as sentences:** `it("keeps a book's progress when its file moves to another folder")`.
  Route-level integration tests against in-memory SQLite are the most valuable kind; prefer them to
  mocking internals.
- **Check in a real browser.** About half the bugs found in whatGamesNext were invisible to its tests
  (wrapping buttons, charts the wrong way round, duplicate accessible names). Drive the app with
  Playwright and **look at the screenshots** before calling anything done. Check wrapping, keyboard
  use, accessible names, light/dark, and reduced motion.
- **Measure claims.** "Faster" needs a benchmark and a number, with the dataset and machine stated.
  Synthetic benchmarks don't prove real-drive performance.
- **CI** runs `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` on every push.

### What you can't test in your sandbox

You don't have the owner's files, their Windows PC, or reliable access to every data source.

- Build each data source against **recorded fixtures**, verified by unit tests.
- Drive the UI with the **demo library** (§17).
- Put everything Windows-specific (drive identity, iCloud placeholders, Open / Show in folder) behind
  a small interface with a fake. List it in the milestone notes as **"needs checking on the owner's
  machine"**. Passing fakes doesn't prove it works — don't claim it does.
- Use the **Milestone 0 probe report** (§18) as your real evidence about the owner's PC, and build the
  fakes to match what it found.

## 6. Architecture

### 6.1 Stack and layout

```text
whatBooksNext/
  server/src/
    db/        schema, numbered migrations, snapshots
    scan/      folders, availability, light pass, deep pass, formats/
    identify/  filename parser, candidates, confidence, grouping, merge/split
    sources/   openlibrary, googlebooks, hardcover, anilist, metron, comicvine
    lib/       score, eligibility, modes, taste, progress, backup, import
    platform/  Windows adapters (volumes, file attributes, launching) + fakes
    routes/
  web/
  fixtures/    generated EPUB/CBZ/PDF files, recorded API responses, filename cases
  data/        (gitignored) database, covers/, snapshots/
  start-whatBooksNext.bat
```

- **Node:** the range better-sqlite3 ships native builds for — check whatGamesNext's `package.json`
  and the current release.
- **Heavy work off the main thread.** Archive and PDF parsing, word counting, hashing and thumbnails
  run in a small `worker_threads` pool so the UI stays responsive during a scan.
- **Bound every file's processing** — time, uncompressed archive size, compression ratio, image
  dimensions (§20). A corrupt or malicious file is recorded in Library health and skipped; it never
  stalls the scan.
- **Cap the pool and each worker's memory** (`worker_threads` `resourceLimits`, §20), so a few huge
  PDFs at once can't exhaust the PC.
- **Archives are read in memory or as streams, never extracted to disk**, and entry names are never
  used as file paths.

### 6.2 Migrations and snapshots

- Numbered SQL migrations, applied in order at startup; schema version stored in the database.
- **Before migrating, take a consistent snapshot** using the
  [SQLite Online Backup API](https://www.sqlite.org/backup.html) (better-sqlite3 exposes it as
  `db.backup()`), not a file copy — copying a live database file can produce a corrupt backup.
  Name it with the date and old schema version; keep the last 5.
- Each migration runs in a transaction. If one fails, roll back, **don't start normally**, and show
  how to recover (which snapshot to restore). Never silently start with a fresh database.

### 6.3 Credentials and local security

API keys live in settings, masked in the UI with a Show button, and are **excluded from backups and
exports** (the export says so).

**A local app with no login can be triggered by any website the owner visits**: a malicious page can
send requests to `127.0.0.1`, including the route that opens files. So:

- Bind to `127.0.0.1` only.
- **Reject any request whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>`.** This
  blocks DNS-rebinding attacks.
- **State-changing requests** (POST/PUT/PATCH/DELETE) must send `Content-Type: application/json`,
  which forces a browser preflight. Reject them if an `Origin` header is present and isn't the app's
  own. Send no CORS headers, ever.
- Open and Show in folder are POST-only and take ids, never paths (§14).
- **Text from files and outside sources is untrusted.** Show descriptions as plain text, or clean
  them with a maintained HTML sanitizer that keeps only a small allowlist (paragraphs, line breaks,
  emphasis, lists). Never insert raw HTML.
- Covers are served from the data folder by id only.

### 6.4 Pure scoring

Eligibility, scoring, mode selection and taste are **pure functions** — items, user data and
settings in; rankings out. No database or Node-specific calls inside.

### 6.5 Built so the Cloud release can come later

Cheap now, expensive later:

- **Facts from files and sources are stored apart from what the owner enters.** A future sync moves
  the catalogue and the owner's data, never file paths.
- **Item ids are UUIDs that never change** — not when files move, not when a match is corrected.
  Merged-away ids are kept as aliases.
- **Every owner edit has an `updated_at`**, and deletions and merges are recorded. (That's the raw
  material; the sync rules themselves are designed in the Cloud release.)
- Scoring is pure (§6.4), so it can run in a browser or serverless function unchanged.

## 7. Data model

A sketch — refine as you build, but keep these distinctions.

| Table | Holds |
| --- | --- |
| `folders` | Display path, **volume identity**, path relative to the volume, last-known drive letter, storage kind (`local` / `external` / `cloud`), last seen, **last complete scan**. |
| `directory_scans` | For each directory, when it was last **completely** listed. Drives the missing-file rule (§9.3). |
| `files` | Folder, relative path, size, created and modified times, format, partial and (when computed) full hash, **availability** (`present` / `placeholder` / `unknown` / `missing`), processing stage + version, last seen. **Edition details:** language, abridged flag, edition note, and the file's own word count / page count. |
| `items` | The thing you'd recommend: a book, collected edition, manga volume, or comic series run. UUID, kind, reference flag, title, creators, series + position, publication year, identifiers, and the ranking fields (rating, rating count, length, effort), each with **the source that supplied it**. |
| `item_files` | Which files belong to an item, and which one is primary. |
| `issues` | For a series run: issue **label** (string — "1", "1.5", "Annual 1", "0") and a separate **sort key**, per-issue read state and date, files. |
| `collection_coverage` | For a collected edition: the series run it collects and issue ranges, with state `suggested` or `confirmed`. |
| `locations` | Where an item can be read: a file, a store (`kindle`, `kobo`, `globalcomix`, `apple_books`, `other`), or `history` (read, not owned). |
| `source_cache` | Raw responses: source, the source's id, fetched date, payload. Re-derive item fields from here when matching logic changes. |
| `user_item` | Progress bucket, next / last-completed issue, DNF reason, dates (with precision: exact / approximate / unknown), triage + date, rating 1–10, note, takeaway, hidden, shortlist position, overrides (title, kind, effort, reference, coverage), optional acquisition date, `updated_at`. |
| `operations` | Merge/split undo stack: the before-state of affected records (JSON), newest first, last 20 kept. |
| `id_aliases` | Retired item id → surviving id. |
| `candidates_rejected` | Item + source id the owner said is *not* a match, so it's never re-accepted. |
| `review_state` | Review items the owner deferred (until a date) or dismissed. |
| `pick_feedback` | "Not this, because…" answers: item, mode, situation (time control, mood), reason, date. Read by the quality sessions (§17.2). |
| `scan_runs`, `enrich_runs` | Progress, counts, errors, cancelled flag. |
| `settings` | Reading speeds, time presets, topic interests, weights, taste strength. Secrets kept apart (§6.3). |

## 8. What gets recommended

| Files | Item |
| --- | --- |
| A novel, nonfiction, self-help or tech book (any formats) | One **book** |
| A trade paperback / graphic novel / collected edition | One **collected edition**, in its series |
| A manga volume | One **manga volume**, in its series |
| Single issues of one comic series | One **series run** (keyed by series + volume or start year), with `issues` |

- **Kinds:** `fiction`, `nonfiction`, `self_help`, `tech`, `comic`, `manga`. Inferred from source
  subjects, file type, AniList (manga), known tech publishers (O'Reilly, No Starch, Manning, Packt,
  Pragmatic…) and title words. Guesses are reviewable and overridable.
- **Reference is a separate flag**, combinable with any kind (a tech book can be a reference book).
  Suggested by title words ("Cookbook", "Handbook", "Reference", "Rulebook"), always overridable.
  Reference items appear in Skim and topic interests, and are left out of backlog totals and
  "Waiting on your shelf".
- **One per series in every mode:** pick the series' next eligible owned unread installment
  *before* ranking. If an earlier installment is in progress, that one comes first. Skipping ahead
  never marks the skipped ones read. The Library can show every installment or group by series.
- **Reading order follows the source's series order.** Entries with no series position (side stories,
  specials without a number) are treated as standalone. Alternate reading orders are out of scope for
  v1.

## 9. Scanning and storage

### 9.1 Formats

- **Deep-scanned:** `.epub`, `.pdf`, `.cbz`, `.cbr`.
- **Light-scanned only:** `.mobi`, `.azw3`, `.cb7` — listed, parsed by filename, and *suggested* for
  grouping with a sibling file.
- Anything else is ignored; the scan summary reports counts by type.

### 9.2 Two passes

1. **Light pass** — every reachable folder. Records names, paths, sizes, dates and availability
   (§9.5) **without reading file contents**. The filename parser (§11.1) runs here, so even
   online-only files get a useful guess.
2. **Deep pass** — only files confirmed `present`. Reads metadata (§10), counts words and pages,
   makes a thumbnail, computes the partial hash.

Each file records which processing stages have run and at which version. A stage is skipped only if
it completed at the current version. **A file that changes from `placeholder` to `present` gets a
deep pass even if its size and date didn't change.** A "Refresh" action re-runs stages after the
parser improves.

### 9.3 Missing, moved and disconnected files

- An **unreachable folder** is skipped and reported ("External drive not connected"), never treated
  as empty.
- A file becomes `missing` **only if its own directory was completely listed in this scan and the
  file wasn't there.** A reachable root isn't enough: a drive unplugged halfway, an access error or a
  cancelled scan leaves the unlisted directories' files exactly as they were (marked stale), never
  missing.
- Missing files **keep all user data**, and become `present` again if they return.
- **Moves are matched cautiously.** A new file whose size and partial hash match a missing one is a
  *candidate* move. Transfer history automatically only when the full hash also matches (computable
  when both are local) or the old file's stored evidence is otherwise conclusive; otherwise send it to
  Needs review. A similar name alone never moves history.
- **Two present copies are duplicates, not a move.** Suggest them in Needs review.
- Overlapping folders, symlinks and Windows junctions are listed once, with loop protection.

### 9.4 Drive letters change

Store each folder as volume identity + relative path + last-known letter. On scan, if the expected
letter doesn't hold that volume, look for it on other letters (Windows adapter, e.g. PowerShell
`Get-Volume`). Offer **"Reconnect this folder"** for manual repair. **Needs checking on the owner's
machine.**

### 9.5 iCloud placeholders

Node's `fs.stat` doesn't expose the Windows attributes that mark online-only files. Read attributes
for a folder in one batch through the Windows adapter (e.g. PowerShell `Get-ChildItem -Recurse -File`
with `Attributes`). Treat `RecallOnDataAccess`, `RecallOnOpen` or `Offline` as **placeholder**, and
any failure to read attributes as **unknown**.

- **One guard in front of every content reader** (metadata, hashing, thumbnails, PDF rendering).
  Placeholder or unknown → no read.
- **Re-check just before reading**, not only at scan time.
- **Open on a placeholder asks first:** "This file is in iCloud and will download when opened. Open
  anyway?"
- **Needs checking on the owner's machine** with a real online-only file, including what happens when
  a file is downloaded or freed up between scans. Windows is the supported platform; other platforms
  need their own validation.

### 9.6 Cancel and resume

Scans and lookups can be cancelled; they stop after the current file. Progress is saved per file and
stage (scan) and per item (lookups), so the next run skips completed work and retries failures. A
worker that exceeds its time limit is stopped and the file recorded as failed. Show counts, and an
estimate only once there's enough progress for it to mean something.

### 9.7 Scan reminder

On opening the app, show a banner for any folder whose **last complete scan** is over 30 days old:
_"External drive: last complete scan 34 days ago. Plug it in and scan."_ Partial scans don't reset
the date. Dismissing snoozes it for 7 days. Settings shows last seen and last complete scan per
folder.

## 10. Reading metadata from files

| Format | Read |
| --- | --- |
| **EPUB** | OPF: title, creators, language, publisher, date, identifiers, subjects, description, series (`calibre:series`, `calibre:series_index`, EPUB 3 `belongs-to-collection`), cover. Word count from the spine text, skipping navigation and repeated boilerplate where practical. |
| **CBZ / CBR** | `ComicInfo.xml` if present: Series, Number, Volume, Title, Year, Writer, Penciller, Publisher, Genre, `Manga` (incl. right-to-left), PageCount. Otherwise the filename. Cover and page count from the images in order. |
| **PDF** | Info and XMP metadata, page count, text-layer word count, ISBN **candidates** from the first ~10 pages, a small page-1 thumbnail. |
| **MOBI / AZW3 / CB7** | Light pass only. |

- **EPUB identifiers are strong evidence; ISBNs found inside a PDF are only candidates** — a tech book
  often quotes other books' ISBNs. Corroborate with title/author before accepting.
- **PDF type** (comic / text / scanned book / uncertain): sample pages. Mostly full-page images in a
  portrait comic shape with little text → comic. Mostly text → book. Neither clearly → **uncertain**,
  with the evidence shown and an override. Image-heavy tech books and scanned novels can look like
  comics; don't force a type.
- **Libraries:** your choice after checking they're maintained — e.g. a ZIP reader + XML parser,
  `pdfjs-dist`, a WASM unrar such as `node-unrar-js` (avoids native builds on Windows), `sharp` for
  thumbnails. Justify each.

## 11. Identification

### 11.1 Filename parser

- Strip the extension, bracketed release/scanner tags and `(Digital)`. Pull out volume (`vol1`,
  `v01`, `Vol. 1`), issue (`001`, `#1`), year (`(2012)`) and `Author - Title` / `Title - Author`
  patterns (ambiguous — keep both candidates).
- **Run-together names:** keep the raw form *and* try a word-frequency split
  (`boatofamillionyears` → `boat of a million years`, the "wordninja" approach). The split is a
  fallback guess, not authority — it fails on names and non-English titles.
- **Comparing titles:** lowercase, remove punctuation and spaces, **and strip a leading article
  (the / a / an)** on both sides — otherwise `boatofamillionyears` never matches
  "theboatofamillionyears". Test this rule explicitly.
- Folder names are low-confidence hints (`Comics/Image/Saga/` → publisher Image, series Saga).
- Output each part with how confident it is, and keep the raw name.

Fixture table to grow (add the owner's samples after M1):

| Filename | Expected |
| --- | --- |
| `boatofamillionyears.epub` | title "boat of a million years"; the EPUB's own metadata should win |
| `shadowservice_vol1_darkarts.pdf` | series "shadow service", volume 1, subtitle "dark arts" |
| `Saga 001 (2012) (Digital) (Zone-Empire).cbz` | series "Saga", issue 1, year 2012 |
| `Berserk v01 (2003).cbz` | series "Berserk", volume 1, year 2003 |
| `Clean Code - Robert C. Martin.pdf` | title "Clean Code", author "Robert C. Martin" |

Keep some examples **held out** from tuning, so the match report measures real accuracy.

### 11.2 Matching and confidence

Evidence, strongest first: corroborated identifiers → embedded metadata → filename → folder hints.
Score candidates from the sources (§12) on title, author, series/volume and year agreement. The
score is a heuristic for sorting, not a probability.

| Score | Result |
| --- | --- |
| ≥ 0.90 | Accepted |
| 0.60 – 0.90 | Accepted provisionally, shown as "unconfirmed", listed in Needs review |
| < 0.60 | Left unidentified — title from filename, neutral scores — listed in Needs review |

Thresholds start where §20 says and are tuned against the fixture set, with the results recorded in
a comment. **Merging items or transferring history needs stronger evidence than displaying a
match** — a provisional match never triggers a merge.

**Ties:** if the top two candidates score within 0.05 of each other, neither is accepted. The item
stays provisional and Needs review shows both.

### 11.3 Grouping

- **Same folder + same base name + different formats → grouped automatically**: one item, several
  files, an available EPUB as primary. This is how Humble and most stores deliver one book in several
  formats; sending every trio to review would bury the queue.
- Elsewhere (different folders or names), files are grouped automatically only when a corroborated
  identifier matches on both. Otherwise it's a suggestion in Needs review.
- **Files that differ in language, abridgment or edition number are never merged automatically**,
  even under the format-trio rule. They become separate items unless the owner merges them. Each file
  keeps its own length, and the item uses its primary file's length.
  - **Unknown language** counts as different from a known one (suggest, don't merge). Two unknowns
    don't block grouping.
  - **A revised edition** (a tech book's 2nd vs 3rd edition) is a separate item. If the owner has the
    newer one, "Still relevant?" suggests Never for the older.
- A file and a store copy of the same work → one item, two locations.

### 11.4 Needs review

Lists provisional and unidentified items, guessed kinds, uncertain PDF types, duplicate candidates,
and candidate moves. Each row shows the raw filename, embedded metadata, the chosen candidate and
any conflicting fields. Actions:

- **Search and pick**, **Confirm**, **Not this one** (recorded in `candidates_rejected` — never
  re-accepted), **Leave unidentified**, **Fix kind / reference / PDF type**.
- **Merge** and **Split** with a preview **of conflicts only** — e.g. "one is *Halfway*, the other
  *Finished*: keep which?"; for a split, which files, issues and user data go where. Completed
  reading is never credited twice.
- **Undo** steps back through the last 20 merges/splits (`operations` table). Undo is offered only if
  the affected items haven't been edited since (progress, rating, note, triage…). If they have, it
  offers a **Split** with preview instead, so the owner decides where the later edits go — nothing is
  silently lost. Other edits have no undo history.
- **Defer** (hide until a date) and **Dismiss** (accept as is) for anything low-value.

**Order and load.** The queue is tiered, with a count per tier, and works top-down:

1. **Could damage history:** candidate moves, merge conflicts.
2. **Conflicting identity:** tied candidates, provisional matches with conflicting fields.
3. **Unidentified items that matter now:** shortlisted, in progress, or appearing in recommendations.
4. **Everything else:** guessed kinds, uncertain PDF types, optional improvements.

Review never blocks recommendations. Tier 4 is collapsed by default.

### 11.5 Match quality report

**Measure identification before ranking is built on it.** Needs review's header and
`npm run report:matches` (run over the fixtures) report:

- coverage by format, kind and confidence band;
- **precision on labelled examples, and the count of wrong high-confidence matches** — this is the
  number that matters;
- the review workload (how many items need the owner).

Never trade correctness for a higher identified percentage. When the owner provides real filenames,
this report shows whether things improved.

## 12. Lookups, ratings and estimates

### 12.1 Sources

One adapter interface: caching (§7 `source_cache`), polite per-source rate limits, resumable
per-item results, a circuit breaker, and a recorded source for each field used. A transient failure
never erases good data. **Verify each source's current access rules, limits and terms when you build
its adapter.**

| Source | Used for | Access (last known — verify) |
| --- | --- | --- |
| **Open Library** | Book search, ISBN, subjects, covers, first publication year | No key. Descriptive User-Agent; about 1 request/second. |
| **AniList** | Manga: score, tags, genres, volumes, publication status, reading direction | No key. GraphQL. Per-minute limit (90 nominal, lowered to 30 at times) — obey the response headers. |
| **Google Books** | Fallback search, ISBN, categories, page counts | Works without a key at low volume. |
| **Hardcover** | Book ratings + counts, series, genres | Free token from the user's account. GraphQL, labelled beta — expect changes. |
| **Metron** | Comics: series, issues, creators, arcs; possibly collected-edition contents | Free account. Little or no rating data. |
| **ComicVine** | Comics fallback | Free key; unique User-Agent; about 200 requests per resource per hour. |

**Open Library + AniList are the keyless baseline** and come first (M3).

**Hardcover is shown as "Recommended" in first-run setup** — optional and skippable — because
keyless book ratings are thin. Before showing it that way, **verify** that the token works, that the
API returns what we need (ratings, rating counts, series order), that its rate limits suit a few
thousand books, and that its terms allow this personal use. Do this in M0 if the owner already has an
account, otherwise at the start of M3. If it isn't usable, say so plainly and drop the
"Recommended" label. Diagnostics shows every source's status ("Hardcover: connected", "ComicVine:
no key").

**Data coverage by kind.** Stats and Needs review show how much of each kind has a rating, a length
and series information (e.g. "Novels: 62% rated · Comics: 3% rated"), so the owner can see where
picks rest on less data. Expect Western comics to have almost no community ratings with or without
keys.

### 12.2 Ratings

- Store each source's raw score, vote count and scope (book / volume / series).
- Normalise to 0–100, then shrink toward **that source's own average** in proportion to how few votes
  there are (Bayesian average; constants in §20). Don't pool sources into one average — a 4.0 on one
  site doesn't mean the same as 80 on another.
- **Your rating and the community rating are shown separately.** Your rating, when present, is what
  the ranking uses.
- Community rating preference: Hardcover → AniList → Google Books → Open Library, where the scope
  matches. **A series score is never shown as a volume's score.**
- Unknown rating: neutral in the blend; **fails** any "highly rated" filter.

### 12.3 Duration

- **Prose:** words ÷ reading speed for the kind (§20). **Comics/manga:** pages × seconds per page.
  **No word count:** pages × assumed words per page, marked rough. **No page count:** unknown.
- Store a **range** (low–high), the basis ("from 84,000 words"), and the unit (whole book / volume /
  issue). Never apply a series' length to one installment.
- **What counts as a fit** for "Finish within" and One-sitting reads: the length is **measured** (a
  word or page count from the file itself) **and** the high end of its range is within the budget.
  Lengths from a source's page count × assumed words per page are always **rough** and only appear
  under "might fit".
- The ±20% range is an **assumed spread**, not a measured confidence. Never present it as one.
- **Remaining time** for an in-progress book comes from its progress bucket and is always labelled
  rough.
- Defaults are assumptions to be calibrated against the owner's actual reading.

### 12.4 Effort

Light / Medium / Heavy / Unknown — how demanding, separate from length. From kind, a readability
sample from the text, and reference/tech signals. Readability helps but doesn't measure conceptual
difficulty, so treat the result as rough. Owner overrides win.

### 12.5 Series, coverage and gaps

- Series and order from embedded metadata, Hardcover, AniList, Metron/ComicVine.
- **Collection coverage:** each collected edition lists the issue ranges it contains ("1–6"),
  either **suggested** (from metadata or a source that states the contents) or **confirmed** (by the
  owner, or typed in directly).
- **Gaps** distinguish: not owned, read elsewhere, covered by a confirmed collection, possibly
  covered (suggested collection — "Gap may be covered by *Saga Vol. 1*. Confirm?"), file
  unavailable, and order unknown.
- **Publication status** (finished / ongoing / unknown) is separate from what you own: owning every
  released volume doesn't mean the story is complete.

**Collections and issues share reading state:**

- Owning a **confirmed** collection fills an *ownership* gap for its issues. It doesn't mark them
  read.
- **Finishing a confirmed collection** marks its covered issues read "via collection", unless they
  were already read.
- **Reading every covered issue** makes the collection count as read "via issues", so it's no longer
  recommended. Reading only some issues changes nothing about the collection.
- **Every reading is counted once.** Stats and taste count what the owner actually marked; the
  "via" states are derived and never counted again.
- Suggested (unconfirmed) coverage has none of these effects.

## 13. Choosing what to read

### 13.1 Eligibility (shared by every mode)

Applied before scoring and before one-per-series selection. **Excluded:** Never, hidden, DNF (until
restored), history-only, and finished items (including collections read "via issues", §12.5). A
series with unread owned installments stays eligible.
Reference items appear only in Skim and topic-interest results.

**Availability labels:** "On external drive (not connected)", "In iCloud (not downloaded)", "In
Kindle". These items **stay eligible**. The **Ready to read** filter keeps only items with a present
file or a location the owner has confirmed they can read from. A store name alone doesn't prove the
book is on the iPad.

### 13.2 Time control

One control with presets — 30 min, 1 h, 2 h, an evening, a weekend, any — and a switch:

- **Read for…** — a reading session. A long novel or a series start can fit; the card shows its total
  length honestly.
- **Finish within…** — the whole book or installment must fit. Only confident estimates count as a
  fit; rough ones appear in a separate "might fit" group.

What "evening" and "weekend" mean is shown on screen and set in §20.

### 13.3 What each card says

Cards state **scope and commitment**: "Whole book · ~4–5 h", "Next issue · ~15–25 min", "Starts a
series · vol. 1 of 12 owned · story ongoing".

**Complete stories only** keeps standalone works, and series whose story is known to be finished
**and** whose every installment the owner owns or has read. Unknown doesn't pass. The card says which
condition fails ("story ongoing", "you're missing vol. 3").

### 13.4 Series gaps on cards

Shown **on the card, before the owner starts**, as text plus an icon — not colour alone, not a
tooltip. Example:

> **Continue with volume 4 — owned.** Gap: volume 3 isn't recorded as owned or read.

Actions: continue anyway, **mark volume 3 read elsewhere**, or fix ownership/coverage. An unowned
volume is never recommended as if owned. No shopping links.

### 13.5 Triage

- **First run offers it up front** ("Sort 15 books to get better picks — or skip"), with
  recommendations available straight away either way.
- One item at a time: cover, title, kind, length, rating, description. **Want / Maybe / Never /
  Already read**, plus **Skip** and **Undo**, all with keyboard shortcuts.
- **Already read** needs no rating or date; an unknown date stays unknown.
- **Never** removes an item from recommendations and backlog totals — not from the Library.
- **Bulk** Already read / Never on a selection, with preview and undo.
- Sessions save their position. **New arrivals** means genuinely new untriaged items (not a new
  format of a known book). Triage a folder. After a scan finds new items: "12 new items — triage
  them?"

### 13.6 Progress

- **Not started → Sampled → Into it → Halfway → Nearly done → Finished**, plus **Did not finish**
  (optional reason: Not for me / Not now / Too difficult right now). One tap each.
- **Comics:** "Next issue to read" and "Last completed issue" are separate; reading out of order
  doesn't mark skipped issues read. **"Finished for now"** means all *owned* issues are read; a newly
  added issue reopens the run.
- Dates are recorded for actions taken now. Past reading (Already read, imports) keeps exact,
  approximate or unknown dates — **never today's date as a stand-in**.
- Rating 1–10, a note, and an optional one-line **takeaway** (offered for self-help and nonfiction,
  shown on Stats).
- **Still reading?** After 90 untouched days in progress: Still reading / Snooze (30 days) / Back to
  not started / Did not finish. Overdue books are gathered into **one** digest ("4 books haven't been
  touched in 3 months"), never a stream of separate prompts.

### 13.7 Ranking

A weighted blend of components, each 0–1, **unknown = neutral** (weights in §20):

- **Rating** — yours if you've rated it, else the community rating.
- **Time fit** — against the time control. In "Read for" mode, shorter isn't automatically better.
- **Taste** (§13.11).
- **Momentum** — in progress, or next in a series you're reading.
- **Triage** — Want boosts; Maybe is neutral.
- **Recency** — a gentle boost for books **acquired** recently (§20). Never rewards buying.

**Acquired date**, in order of preference: a date the owner entered; else the **file date** (the
earlier of created and modified — Windows resets the created date when a file is copied, but keeps
the modified date), labelled "from file date"; else first-seen. If most of a folder shares one
day's file date (a bulk copy), those dates are treated as unknown. First-seen dates from the first
scan never count as recent.

**When ratings are missing**, the rating component is neutral, so among unrated items the order comes
from time fit, triage, momentum and taste. That's deliberate: for Western comics, and for books
without a Hardcover token, the owner's own signals carry the ranking.

**Tune** shows the weights with plain explanations and a Reset.

### 13.8 Why this pick

Each card shows two or three **real** reasons from the score ("Rated 86 by Hardcover readers · fits
your 2-hour session · you finish fantasy") and, separately, any **limitations** ("rough length",
"unconfirmed match", "gap before this volume", "drive not connected"). Missing data never produces a
positive reason.

**"Not this, because…"** — a small action on every card, with one-tap reasons:

| Reason | Effect |
| --- | --- |
| Already read | Marks it read (date unknown unless given). |
| Wrong book | Sends it to Needs review, tier 2. |
| Not in the mood | Hides it for this session (like Surprise me's Not today). |
| Not interested | Offers **Never**. |
| Other | Free text. |

Every answer is logged in `pick_feedback`, with the mode and situation, for the quality sessions
(§17.2).

### 13.9 Shortlist

An ordered "next up" queue: star from anywhere, reorder with accessible ↑/↓ buttons, survives
rerolls.

### 13.10 The ten modes

| Mode | Rule |
| --- | --- |
| **Read next** | The blend (§13.7) with the time control. Shows a manageable set, not the whole library. |
| **Continue reading** | In-progress items. **Shortlisted ones first, in shortlist order** (the owner's explicit choice beats the app's inference), then **Nearly done**, Halfway, Into it, Sampled; within each, most recently touched first. |
| **Next in series** | The next eligible owned installment of each series you've started; an unfinished earlier one first. Gaps warn, never block. |
| **One-sitting reads** | Whole works or single installments that **confidently** fit the Finish-within budget (default 2 h). Rating helps but isn't required. Labelled installment vs standalone. |
| **Waiting on your shelf** | Highly rated, not started, not reference, waiting longest. Uses the acquired date (§13.7), labelled with where it came from. Ties broken by rating. |
| **Hidden gems** | Positive community rating with few votes *for that source* (§20). Missing data is not obscurity. |
| **Classics you missed** | Highly rated, not started, first published 25+ years ago. The description states the rule. |
| **Still relevant?** | A **review list** for tech books: topic interests, version-specific titles ("React 16"), age, and reference use. Actions: Want / Mark as reference / Never / Decide later. Old fundamentals aren't treated as stale. |
| **Mood** | Escape (fiction, comics, manga) / Learn (nonfiction, tech, self-help) / Skim (short items and reference). Re-weights rather than filters. |
| **Surprise me** | A random pick from the top 50 of Read next, weighted toward the top but not dominated by it (§20). Reroll, no immediate repeats, and **Not today** (for this session only — not dislike). |

Every mode uses the shared eligibility and one-per-series rules, and has both a populated demo and an
honest empty state. Never loosen eligibility just to fill the screen.

### 13.11 Taste learning

- Learns from genres, tags, authors, **comic writers and artists**, publishers and kinds that stand
  out from the owner's own average.
- **Evidence strength:** your rating > finished (engagement, not necessarily enjoyment) > imported
  history. **Only "Did not finish — Not for me" is negative evidence.**
- **One series can't dominate:** a series contributes at most a capped amount of evidence (§20), so
  100 issues of one comic don't drown everything else.
- **Inert below a threshold** (§20) — before that it changes nothing.
- **Off / Low / Normal / High** setting. Stats shows what it has learned. The README explains the
  feedback loop (it tends to suggest more of what you already read).

## 14. Store titles, imports and opening files

- **Add by search** (any configured source), choose where it's read. Merge with an existing item only
  on a confirmed match. **Manual entry** when search finds nothing.
- **Store CSV:** `title, author, store, kind, progress, isbn, series, series_index, rating, note`.
  Only `title` required; `store` defaults to "other". Preview matches, conflicts and unmatched rows
  before committing; unmatched rows can be kept as unverified items (no invented identity).
- **Goodreads and StoryGraph history import** (for other users). **Verify the column names against a
  fresh export of each.** Ratings converted explicitly; unknown dates stay unknown. Read-but-unowned
  books become **history-only** — they teach taste but never appear as recommendations.
- **Imports are repeatable**: re-importing the same file doesn't duplicate anything or overwrite
  owner edits. Rows are recognised by ISBN when present, otherwise by normalised title + author +
  store.
- **Open** and **Show in folder** take an item or file **id**, never a path. Check the file is present
  first (placeholder → confirm, §9.5). Use argument-safe launching (Windows: `explorer /select,` and
  the default-app handler; `open` / `xdg-open` elsewhere). Behind the platform adapter — **needs
  checking on the owner's machine.**
- **Store items** show "Read in Kindle" etc. as a **label**, not a link.

## 15. Pages and statistics

| Page | Contents |
| --- | --- |
| **What next** | The ten modes, time control, filters (Ready to read, Complete stories only), cards with reasons, limitations and gap warnings. |
| **Library** | Sort by rating, length, effort, acquired/first-seen date, publication year, last touched. Filter by kind, reference, format, location, availability, progress, triage, length, genre, effort, folder. URL state; group by series; smooth at 5,000 items. |
| **Item detail** | Metadata with its sources, files with edition details, locations, progress, rating, note, takeaway, overrides, series order with coverage and gaps. |
| **Triage** | §13.5. |
| **Shortlist** | §13.9. |
| **Needs review** | §11.4 tiers and actions, match quality header (§11.5), data coverage by kind (§12.1), Library health. |
| **Library health** | Unreadable or corrupt files, scanned PDFs with no text, duplicate candidates, ignored formats — errors kept apart from merely incomplete metadata. |
| **Stats** | Data coverage by kind (rated / length known / series known), backlog count and estimated hours by kind (with **how much of the backlog has a known length**), finishes per year, this year vs last, read rate by kind and by folder (denominators stated), DNF reasons, Never totals, your ratings, taste signals, match summary, takeaways. |
| **Settings** | Folders (last seen, last complete scan, Scan now, Reconnect), stores and imports, API keys, reading speeds and time presets, topic interests, Tune, backups, Diagnostics. |
| **Diagnostics** | Plain-language checks any user can run: each folder's drive found (and as which letter), iCloud online-only files detected correctly (counts by state), Open works on a chosen file, each source's status and last error, database version and last snapshot, Node version. **Copy report** gives plain text with no API keys; filenames are included only if the user ticks a box. This page grows out of the Milestone 0 probe. |
| **First run** | Add a folder → scan → optional short triage → recommendations. No keys required. |

**Stats separate facts from estimates.** Books finished on unknown dates are listed separately, not
counted in any year. Progress buckets can't give exact pages read, so don't show such numbers.
Never and reference items are left out of backlog totals but stay in the Library.

## 16. Backup and restore — from M1

- **JSON backup** of everything except book files, covers and secrets: items, files, issues,
  coverage, locations, user data, aliases, cached field sources, settings. Versioned; extended as
  each milestone adds tables.
- **Restore into an empty app without rescanning or connecting any drive** — store-only,
  history-only and unavailable-file items come back with their original ids.
- Later scans **reconnect files cautiously** (same rules as moves, §9.3). Anything unresolved stays
  unresolved; nothing is lost. Fuzzy titles never reattach progress.
- Validate the file before applying, preview conflicts with existing data, apply in one transaction
  after a pre-restore snapshot. **Test that a corrupt restore rolls back.**
- **Full local snapshot** = database snapshot + cached covers. **CSV export** is for spreadsheets,
  not a complete backup.
- The export states that API keys and book files are not included.
- **A test lists every table in the schema and fails if any is neither in the backup nor on an
  explicit, commented exclusion list**, so a new table can't be silently left out.

## 17. Demo, tests and acceptance

- `DEMO=1` creates a **clearly labelled** demo library with no keys and no owner files.
- Generate **fictional** EPUB/CBZ/PDF fixtures and simple comic page images in code. Bundle any
  third-party file only after checking that specific file's licence.
- Provider fixtures come from **recorded real responses**; fictional demo works may use clearly
  labelled synthetic data. Never invent ids, ratings or claims about real works.
- The demo must include: one book in several formats, two editions that must stay separate (a
  translation), a comic run with a gap and a collection covering it (one suggested, one confirmed),
  manga volumes, text / comic / scanned / uncertain PDFs, placeholder / unknown / missing files,
  ambiguous matches, store titles, history items, and enough rated/finished/DNF history for taste
  learning to switch on — so **every mode has a populated case and a truthful empty case**.
- **Benchmark** ~5,000 synthetic files: light scan, Library rendering, and UI responsiveness during a
  deep scan. Record machine and timings.

### 17.1 Acceptance scenarios

1. "Read for 30 minutes" can suggest a long owned novel, labelled with its full length.
2. "Finish within 30 minutes" never calls a rough 25–40 minute estimate a confident fit.
3. Owning volumes 1, 2 and 4 warns about volume 3 *before* volume 1 is started; after volume 2,
   volume 4 is selectable with the warning; volume 3 is never shown as owned.
4. A collection covering a missing issue resolves that gap only once confirmed; a suggested one shows
   "may be covered".
5. Disconnected and iCloud-only titles stay visible and recommendable with labels; Ready to read
   doesn't assume they're on the iPad.
6. Already read with no date clears the book from the backlog without adding a finish to this year.
7. DNF "Not now" excludes a book without teaching dislike; restoring it makes it eligible again.
8. Skipping triage still gives useful, honest recommendations and a working shortlist with no keys.
9. An old fundamentals tech book isn't treated as obsolete.
10. Cancelling, access errors and unplugging mid-scan never mark unlisted files missing.
11. A partial-hash collision or a similar filename never transfers history silently.
12. Placeholder and unknown files never reach a content reader (asserted with fakes; real behaviour
    checked on Windows).
13. A merge shows conflicting user data, and undo restores the exact prior state — including after
    several later merges.
14. Backup → empty app → restore recovers everything without drives; a later scan reconnects files
    without changing item ids.
15. Two languages of the same book are never merged automatically.
16. "Classics you missed" never includes a book the owner has started or finished.
17. A Humble-style EPUB + PDF + MOBI trio in one folder groups automatically, with nothing added to
    Needs review.
18. Two candidates scoring within 0.05 leave the item provisional, with both shown in review.
19. Merge → change progress → undo offers a split preview instead of discarding the new progress.
20. Finishing a confirmed collection marks its issues read "via collection", and Stats and taste
    count one reading, not one per issue.
21. A request from another website (wrong `Host`, or a foreign `Origin` on a state-changing request)
    is refused, including Open.
22. With zero keys, Stats shows data coverage by kind, and Read next still orders unrated items by
    time fit, triage, momentum and taste.
23. A book description containing HTML and a `<script>` tag displays safely as text.
24. A tech book's 2nd and 3rd editions are never merged.

### 17.2 Recommendation quality sessions (with the owner)

Tests prove the app is correct; only the owner can say whether its picks are good. Twice — after M3
and at M6 — the owner spends about 20 minutes with the app on a real slice of their library (a few
hundred items):

1. Ask for picks in real situations, for example: "30 minutes tonight", "something I can finish this
   weekend", "continue a comic", "I want to learn something", "surprise me".
2. For each, record whether **the top 5 include something the owner would actually start this
   week**, what had to be corrected first, and why the rest were rejected (the `pick_feedback` log
   captures most of this).
3. Write the results to `docs/quality-sessions.md`, then decide what to fix: matching, data
   coverage, weights or modes.

**Target** (the owner's judgement, not a metric): in at least 4 of 5 situations, the top 5 hold
something they'd start this week. A miss is a finding to act on, not a test failure to argue with.

## 18. Milestones

Every milestone from M1 on ends with: four CI checks green, sentence-style tests for new behaviour, the feature
driven in a browser **with screenshots inspected**, README updated, backup/restore covering every
new table, and a list of what "needs checking on the owner's machine".

### M0 — Windows probe (before any app code)

A standalone, **read-only** script the owner double-clicks: `whatbooks-probe.bat` (PowerShell
inside). It needs no AI to run and its report is plain English, so anyone can use it.

- Asks for the library folders, then reports for each: drive letter, volume label and id, file counts
  by extension, and the attribute breakdown (how many files look online-only).
- Asks the owner to name 2–3 files they know are online-only in iCloud. Reads **only their
  attributes**, then confirms they are still online-only afterwards — evidence that reading
  attributes doesn't trigger a download.
- Optionally lists a random sample of up to 300 filenames (names only). The owner can edit them
  before sharing.
- Optionally takes a Hardcover token, makes one test query, and reports what came back. The token is
  never saved.
- **Never opens file contents, never writes anywhere except its own report file**, which goes next to
  the script, never into a library folder.

**Done when:** the owner has run it and shared the report; the platform fakes and filename fixtures
are updated to match it; and the plan's Windows assumptions (§9.4, §9.5) are confirmed or corrected
in the milestone notes.

### M1 — Library and tracking

- Repo, workspaces, TypeScript, CI, localhost binding with the request checks (§6.3),
  `start-whatBooksNext.bat` (checks the Node version and that the port is free, and says what to do
  if not).
- Migrations with consistent snapshots (§6.2).
- Folders, Windows adapters with fakes (volumes, attributes, launching), **light pass** with the
  directory-coverage missing rule and placeholder detection.
- Filename parser with fixtures.
- Library and item detail; manual title/kind corrections.
- Progress, DNF reasons, dates with precision, rating, note; shortlist; Open / Show in folder.
- JSON backup and restore without rescanning, with the backup-coverage test (§16). Demo mode.
- First version of Diagnostics (drives, placeholders, Open).

**Done when:** a fresh clone runs; scan a fixture folder → fix a title → set progress → shortlist →
back up → restore into an empty app with no folders connected, all intact. An unreachable folder is
skipped, not emptied. Scenarios 10, 14 (light-pass level) and 21 pass.

**After M1:** if the M0 sample was thin, ask the owner for more real filenames; add them to fixtures
and held-out examples.

### M2 — Deep scan and file identity

- EPUB / CBZ / CBR / PDF readers; thumbnails, word and page counts; PDF type with "uncertain".
- Worker pool with limits; the single content-read guard with re-check; placeholder → present
  transitions.
- Partial/full hashing, cautious move handling, duplicates, format grouping with the edition rule.
- Cancel/resume, per-folder scan reminder, Library health.

**Done when:** scenarios 11, 12, 15, 17 and 24 pass; a confirmed move keeps progress, an ambiguous
one goes to review; resuming skips completed stages; benchmark numbers recorded.

### M3 — First real recommendations

- Source adapter interface, `source_cache`, rate limits, circuit breakers.
- **Open Library and AniList** (keyless baseline), and **Hardcover** once verified (§12.1), shown as
  Recommended in setup.
- Matching and confidence (including ties); tiered Needs review with search/pick/confirm/reject,
  Defer and Dismiss; match quality report; data coverage by kind.
- Ratings (shrinkage, scopes), duration ranges, effort, kinds and the reference flag.
- Shared eligibility, time control, **Read next**, Why this pick, "Not this, because…", card labels.
- Optional first-run triage, Undo, Skip.

**Done when:** with zero keys, the demo and a fixture folder produce a Read next list whose reasons are
true; the match report shows precision and wrong-high-confidence counts; scenarios 1, 2, 6, 8, 18,
22 and 23 pass; and **the owner's first quality session (§17.2) is done**, with its findings written
down and the important ones fixed or scheduled.

### M4 — Series, other sources and imports

- Google Books, Metron, ComicVine adapters (each optional, verified against current docs).
- Series runs and issues, collection coverage (suggested/confirmed) and its shared reading state
  (§12.5), gaps on cards, publication status.
- Merge/split with conflict preview, the undo stack and the "edited since" rule.
- Store titles (search, manual, CSV); Goodreads/StoryGraph import.

**Done when:** scenarios 3, 4, 13, 19 and 20 pass; imports can be repeated without duplicates; dates keep their
precision; no unowned gap is ever recommended.

### M5 — All modes and taste

- The remaining nine modes, one-per-series everywhere, Ready to read, Complete stories only, mood,
  topic interests.
- Taste learning with threshold, series cap and strength setting; Tune with Reset.
- Bulk, new-arrivals and folder triage; Still reading? prompts; Surprise me's Not today.

**Done when:** every mode has a populated and an empty demo case, screenshots inspected; scenarios 5,
7, 9, 16 pass; taste is inert below the threshold and visibly shifts results above it.

### M6 — Stats and release

- Stats page with facts and estimates separated; Library health and Settings polish; accessibility
  pass.
- CSV export; full local snapshot; restore regression tests across every table.
- Diagnostics completed, with Copy report.
- README for a stranger: install, zero-key use, optional keys step by step (Hardcover first), which
  sources fail soft, limitations, localhost-only access, the taste caveat, backups, measured
  performance, **how to update** (pull, install, start — a snapshot is taken before migrating), and
  **"If it won't start"** (wrong Node version, port in use, failed migration and which snapshot to
  restore).

**Done when:** all 24 scenarios pass; **the owner's second quality session (§17.2)** meets its target
or its misses are understood and scheduled; a stranger can install and use it from the README; every
Windows behaviour is either confirmed on the owner's machine or documented as unconfirmed.

## 19. Roadmap after v1

1. **Cloud release — check and update from anywhere.**
   - The PC keeps everything that needs files (scanner, lookups, keys). A small cloud app holds the
     catalogue and the owner's data. Rule: _files belong to the PC; your opinions belong to the
     cloud._ Upload metadata and small thumbnails only, never book files. The PC pushes only what
     changed.
   - Candidate: **Cloudflare Workers + D1 (SQLite) + Access** for login. As of November 2026, D1's
     free plan allowed 5 million rows read and 100,000 rows written per day with 5 GB storage, and
     queries **fail** once a daily limit is hit (enforced from 1 September 2026); Access was free for
     up to 50 users. **Verify all of it**, including whether Access fully protects a `*.workers.dev`
     address or needs a custom domain. Prefer $0; the owner accepts about $10/year for a domain.
   - Design sync before building it: offline edits, conflicts, deletions, merges and aliases,
     recovery. Timestamps alone don't resolve conflicts.
   - An always-on PC reached through Tailscale is simpler but useless when the PC is off during
     travel, which is the normal case.
2. **"Reading now" hand-off folder** — copy shortlisted files to a folder the owner picks (e.g. in
   iCloud Drive), with a preview of duplicates and space. The only other place the app would ever
   write, and only where pointed.
3. **Kindle for PC library cache** — investigate whether a local list of owned books can be read. No
   promises; search and manual entry remain the fallback.
4. **Optional AI** — opt-in summaries from a book's opening, or "more like this" by text similarity,
   only after ordinary recommendations work well, and only if they measurably help.
5. **Easy install for everyone** — a normal double-click Windows installer, so users don't need to
   install Node or run commands. Check the options when the time comes (e.g. a packaged Node
   executable vs a desktop wrapper) and pick the lightest that works.
6. **Mac and Linux support** — real platform adapters (drive identity, cloud placeholders such as
   macOS "dataless" files, launching), tested on those systems. Until then, Mac/Linux are "should
   mostly work, untested".

## 20. Starting values

All are **assumptions**: starting points with a reason, to be tuned against fixtures and the owner's
use. Keep them in one config module, each with its reason in a comment.

| Setting | Start | Reason |
| --- | --- | --- |
| Reading speed — fiction | 260 wpm | Brysbaert (2019) meta-analysis of adult silent reading: ~260 wpm fiction, ~238 nonfiction (**verify** the citation). |
| Reading speed — nonfiction, self-help | 238 wpm | Same source. |
| Reading speed — tech | 150 wpm | Assumption: code, diagrams and rereading slow technical reading a lot. |
| Comics | 20 s/page | Assumption; calibrate. |
| Manga | 10 s/page | Assumption: fewer words per page; calibrate. |
| Words per page (no word count) | 275 | Assumption: typical trade paperback page; marks the estimate rough. |
| Estimate range | ±20% | Assumption: people's speed varies by book and mood; a range is more honest than a point. |
| "An evening" / "a weekend" | 3 h / 10 h | Assumption; shown in the UI and editable. |
| One-sitting budget | 2 h | A typical uninterrupted reading session. |
| Match: accept / review / unidentified | ≥ 0.90 / 0.60–0.90 / < 0.60 | Cautious start, because wrong matches hurt more than unidentified ones; tune on fixtures. |
| Fingerprint | size + SHA-256 of first and last 64 KB; full SHA-256 for local files when deciding a move | Cheap enough for thousands of files; the full hash settles real ambiguity. |
| Rating shrinkage | Prior weight = **median vote count for that source in this library**; prior mean = that source's mean in this library | Adapts to each source's audience size instead of guessing a constant. |
| "Highly rated" | ≥ 75 / 100 after shrinkage | Assumption: roughly "clearly liked". |
| Hidden gems | ≥ 75 after shrinkage, votes in the bottom 25% for that source, and at least 5 votes | Too few votes is noise, not a gem. |
| Classics age | 25 years since first publication | A generation old; long enough for reputation to settle. |
| Ranking weights | rating 0.35, time fit 0.20, taste 0.15, momentum 0.15, triage 0.10, recency 0.05 | Ratings lead; recency stays a nudge. Adjustable under Tune. |
| Taste threshold | 10 explicit outcomes (rated, finished, or DNF "Not for me"), counted **after** the series cap, from at least 3 different authors or series | Fewer is mostly noise, and ten books by one author teach one thing, not ten. |
| Match tie margin | 0.05 | Closer than this, the "winner" is a coin flip. |
| Recency boost | Acquired within the last 60 days; a folder where over 50% of files share one day's file date is treated as a bulk copy (dates unknown) | New purchases get a look; a bulk copy isn't a purchase date. |
| Surprise me | Random from the top 50 of Read next, probability ∝ score² | Favours good picks while still surprising. |
| Worker pool | CPU cores − 1, at most 4 workers; each capped at 1 GB memory | Keeps the PC usable during a deep scan; large PDFs need headroom. |
| Taste series cap | A series counts as at most 2 items of evidence | Stops one long series dominating. |
| First triage session | 15 items | Enough to help, short enough to finish. |
| Scan reminder / snooze | 30 days / 7 days | Monthly, as the owner asked. |
| Still reading? / snooze | 90 days / 30 days | A quarter untouched usually means stalled. |
| Undo stack | Last 20 merges/splits | Covers a cleanup session. |
| Pre-migration snapshots kept | 5 | A few versions back, without filling the disk. |
| Per-file limits | 60 s; uncompressed ≤ 4 GB; compression ratio ≤ 100:1; images ≤ 50 megapixels | Large comic archives are fine; zip bombs and runaway files aren't. |
| Light-scan target | 5,000 files in under 30 s on a local SSD | A goal to measure against, not a claim. |

## 21. Still to confirm (not blocking)

- The M0 probe report: real filenames (including any non-English titles), drive identity, iCloud
  placeholder behaviour.
- Later on the owner's Windows PC: drive letter changes, download transitions, Open / Show in folder.
- Hardcover's suitability (§12.1) before it's labelled Recommended; other optional keys if the owner
  wants them (Metron, ComicVine).
- The two owner quality sessions (§17.2).
- Reading speeds and thresholds, once there's real use to calibrate against.
- Each source's current access rules and export column names, when its adapter is built.

No further product decisions are needed to start M1.
