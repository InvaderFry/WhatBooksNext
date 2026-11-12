# whatBooksNext — Project Plan (v5)

The handoff document for the AI agent starting this project in a new, empty repository. It is
standalone: it replaces every earlier version (the original plan, the revised plan, v3 and v4), and
you don't need any of them.

Read it all before writing code. It says what to build, in what order, and why — including decisions
the owner has already made, so they don't get reopened.

Written November 2026. Nothing here has been built yet. Facts about outside services were checked
when written but change; anything marked **verify** must be rechecked before you rely on it. Every
tunable number lives in **§20 Starting values**, labelled as an assumption with its reason.

---

## 1. What changed

### After M2 (November 2026)

| Area | Change | Why |
| --- | --- | --- |
| **Calibre** | A modest, read-only **Calibre import** joins the Goodreads and StoryGraph imports in M4 (§14). Folder scanning stays the default way in; automatic syncing with Calibre is deferred (§19). | The owner's decision: whatBooksNext is a reading-decision tool that works with an existing collection, including one managed in Calibre — not a second library manager. |

### From the M0 probe report (November 2026)

The owner ran the Milestone 0 probe. Title-free findings are in `docs/milestones/M0.md`. The
plan changes below are corrections that follow from those facts.

| Area | Change | Why (probe finding) |
| --- | --- | --- |
| **Storage** | The library is one external USB drive. **iCloud isn't installed on the PC.** The owner uploads copies to iCloud to read on the iPhone and iPad, so to this app iCloud is a *place to read*, not a folder to scan (§3). | No iCloud process, no iCloud folder, and no placeholder bits on any book file. |
| **Placeholders** | §9.5 stays, built and tested with fakes, because OneDrive and other users' iCloud need it. It's unconfirmed on real files and not on the owner's main path. | Nothing to test on the owner's PC. |
| **Drive kind** | "External" comes from the disk's **bus type** (USB), not the drive type (§9.4). | Windows reports the USB drive as *Fixed*. |
| **Copies** | Copies are mostly *within* the one drive. Rule 1 (§11.3) applies to any two directories, including two in the same folder. | 262 name+size groups in several directories, 22 of them with 3+ copies. |
| **Bulk-copy dates** | Bulk-copy detection runs on the whole library folder, not on each subdirectory (§13.7, §20). | In 114 of 115 large directories most files share one modified day: one bundle, one download day. That date is real. Created dates reset on copy (99% are later than modified). |
| **Filename parser** | New rules: download-duplicate `(1)`, size/source tags, Humble numeric ids, a trailing "the", `V1 17` series-volume + issue, issue files naming their trade volume, edition words (§11.1). | Patterns seen in the owner's sample. |
| **Stores** | `google_play` added to store locations (§7). | The owner buys from Apple, Amazon and Google Play. |

### From v4 to v5

From a fourth review, all approved by the owner. Mostly contradictions fixed and gaps closed.

| Area | v5 change | Why |
| --- | --- | --- |
| **Copies across folders** | The same file on the hard drive and in iCloud (matching full hashes, or same filename + exact size when hashes can't be compared, and no hash disagreeing) is **one item with several files**, grouped automatically (§11.3). Moves use the same rule (§9.3). | The owner keeps copies in several places; under v4 every copy would have landed in Needs review. |
| **Format groups** | Only a *known* language / abridgment / edition conflict blocks the same-folder rule; unknown never does. HD versions group with their standard version. Filename-only grouping starts in M1. | v4's "unknown language is different" made scenario 17 impossible (MOBI never reports a language). |
| **Hashing** | Full hash computed for every present local file in the deep pass, cached, on its own time limit (§9.3, §20). | v4 asked for the full hash of a file that was already missing. |
| **Series table** | `series` gets its own row and id (§7). | Publication status, order, gaps and one-per-series need a stable series, not a name string. |
| **Highly rated** | Relative to each source's scores in this library (§12.2, §20). | One fixed threshold across sources contradicted "don't pool sources". |
| **Public repo** | Real filenames, probe reports and quality-session notes stay out of git (§5). Licence: PolyForm Strict 1.0.0. | The repo is public; the owner's library and taste are private. |
| **Zero-key is the main path** | The owner has no Hardcover account and most users won't either. The owner will make one at the start of M3 **when asked** (§21). Hardcover leaves the M0 probe. | Keeps M0 a pure Windows check. |
| **Smaller rules** | iCloud attribute bits, re-check mechanism, worker memory, `stale` flag, "measured" length, reference in Still relevant?, undo order, restore = replace, dev-server and upload rules for local security, CI on Windows, default port, Read next size, Still relevant? order, session scope. | Each closed an ambiguity the review found. |
| **Owner actions** | Listed in one place (§21) so the agent prompts for them. | The owner asked to be told when something is needed. |

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

It is a loose sibling of **whatGamesNext** (`github.com/InvaderFry/whatGamesNext`), which does the
same job for games. That repo is background only — you don't need to read it, and nothing here
depends on it. This project is its own thing; the habits worth keeping are written down in §5.

## 3. The owner

- Runs the app on a **Windows PC**. Reads mostly on an **iPhone and iPad** in Apple Books,
  PocketBook, the Kindle app and others. No e-reader.
- **A few thousand files**: fiction, nonfiction, self-help, tech books, Western comics, manga,
  reference books. Many from Humble Bundle, so filenames are often run-together lowercase slugs.
- **Storage:** one external USB drive that isn't always connected (about 8,000 files, about 3,800 of
  them books). **iCloud is not installed on the PC.** The owner uploads most local books to iCloud
  and reads them on the iPhone and iPad, so iCloud is somewhere books are *read*, not a folder
  the app scans (M0 probe). The same file often exists in several directories on the drive. OneDrive is set up on the PC. Often a
  book comes as an EPUB and a PDF with the same name; rarely there's also
  an HD version.
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
| **Public repo, "look, don't reuse"** | The repo is public. Licence: **PolyForm Strict License 1.0.0**, copyright "InvaderFry" — people may read the code and run it for themselves, not change or redistribute it. `LICENSE` added in M1. The owner's library stays out of git (§5). |
| **Folders first; Calibre is an import** | Scanning folders is how books get in. A Calibre library is read on request (§14), never synced automatically and never written to. |
| **Restore replaces** | Restoring a backup replaces all app data, after a snapshot and a preview. No merging into existing data in v1 (§16). |

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
  verified to work for this use (§12.1). The owner has **no account today**, and most new users
  won't either, so **the zero-key experience is the main path**, not a fallback. The owner will
  create a free account at the start of M3 for the check — **tell them when** (§21).
- **Milestone 0 probe:** the owner will run it if needed. It must work without any AI involved.
- **Copies:** the same filename with the exact same size in two places is the same file, grouped
  without asking — unless their hashes disagree (§11.3).
- **Tell the owner when they need to do something** (§21 lists every owner action).

## 5. How to work on this codebase

Habits learned the hard way on whatGamesNext.

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
- **CI** runs `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` on every push,
  on **both Ubuntu and Windows** (at least `npm test` on Windows) — Windows is the only supported
  platform, and paths and native modules break there first.

### Keep the owner's library out of the public repo

The repo is public. Nothing that reveals the owner's library or taste is committed:

- **Real filenames** live in `fixtures/private/` (gitignored). Committed fixtures use **invented**
  names that copy the real patterns. CI measures accuracy on the invented set; `npm run
  report:matches` also runs on the private set when it's present, on the owner's machine or yours.
- **The M0 probe report** is shared in chat, never committed. Milestone notes keep a summary without
  titles (counts, attribute patterns, filename shapes).
- **Quality-session notes** (§17.2) go in `docs/private/` (gitignored). Only a title-free summary of
  findings is committed.
- Screenshots, benchmarks and bug reports use the demo library, never the owner's.

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
    sources/   openlibrary, hardcover, anilist, metron, comicvine
    lib/       score, eligibility, modes, taste, progress, backup, import
    platform/  Windows adapters (volumes, file attributes, launching) + fakes
    routes/
  web/
  fixtures/    generated EPUB/CBZ/PDF files, recorded API responses, filename cases
    private/   (gitignored) the owner's real filenames
  docs/private/ (gitignored) quality-session notes
  tools/probe/ whatbooks-probe.bat (M0)
  data/        (gitignored) database, covers/, snapshots/
  start-whatBooksNext.bat
  LICENSE      PolyForm Strict 1.0.0
```

- **Node:** the current LTS line that better-sqlite3 ships prebuilt binaries for on Windows —
  **verify** against its latest release, and pin it in `engines`.
- **Port:** default **4818** (unlikely to clash with common dev tools), overridable
  with `PORT`. The start script checks it's free.
- **Heavy work off the main thread.** Archive and PDF parsing, word counting, hashing and thumbnails
  run in a small `worker_threads` pool so the UI stays responsive during a scan.
- **Bound every file's processing** — time, uncompressed archive size, compression ratio, image
  dimensions (§20). A corrupt or malicious file is recorded in Library health and skipped; it never
  stalls the scan.
- **Cap the pool and each worker's memory** (§20), so a few huge PDFs at once can't exhaust the PC.
  `worker_threads` `resourceLimits` only caps the JavaScript heap — not image buffers, sharp/libvips,
  canvas or WASM memory. So also turn off sharp's cache and limit its concurrency, enforce the
  per-file limits *before* decoding, and process one large file per worker at a time.
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
  own. Send no CORS headers, ever. GET requests never change anything.
- **File uploads** (backup restore, CSV import) are read in the browser and sent **as JSON**, never
  as `multipart/form-data` — a multipart POST skips the preflight these rules rely on.
- **In development only**, the allowed `Host`/`Origin` list also includes the Vite dev server's
  port, because its proxy forwards the browser's headers. Production allows only the app's own port.
- Open and Show in folder are POST-only and take ids, never paths (§14).
- **Text from files and outside sources is untrusted.** Show descriptions as plain text, or clean
  them with a maintained HTML sanitizer that keeps only a small allowlist (paragraphs, line breaks,
  emphasis, lists). Never insert raw HTML.
- Covers are served from the data folder by id only. A book without a file cover (store books, reading history) gets one from Open Library
  once it is matched there with confidence (owner decision 2026-11-11; `identify/covers.ts`): by cover ID
  through the Open Library client, saved as `covers/item-<id>.jpg`, never for a provisional or rejected match.

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
| `folders` | Display path, **volume identity**, path relative to the volume, last-known drive letter, storage kind (`local` / `external` / `cloud`), **also in iCloud** flag (§13.1), last seen, **last complete scan**. |
| `directory_scans` | For each directory, when it was last **completely** listed. Drives the missing-file rule (§9.3). |
| `files` | Folder, relative path, size, created and modified times, format, partial and (when computed) full hash, **availability** (`present` / `placeholder` / `unknown` / `missing`), a separate **`stale`** flag (its directory wasn't completely listed in the latest scan, §9.3), processing stage + version, last seen. **Edition details:** language, abridged flag, edition number, quality tag (e.g. HD), edition note, and the file's own word count / page count. |
| `series` | A series with its own UUID: name, kind, **publication status** (finished / ongoing / unknown), number of installments when a source states it, source ids, which source supplied the order, `updated_at`. One series can hold collected editions *and* an issue run of the same story, so one-per-series treats them together. |
| `items` | The thing you'd recommend: a book, collected edition, manga volume, or comic series run. UUID, kind, reference flag, title, creators, **series id** + position, publication year, identifiers, and the ranking fields (rating, rating count, length, effort), each with **the source that supplied it**. |
| `item_files` | Which files belong to an item, and which one is primary. |
| `issues` | For a series run: issue **label** (string — "1", "1.5", "Annual 1", "0") and a separate **sort key**, per-issue read state and date, files. |
| `collection_coverage` | For a collected edition: the series run it collects and issue ranges, with state `suggested` or `confirmed`. |
| `locations` | Where an item can be read: a file, a store (`kindle`, `kobo`, `globalcomix`, `apple_books`, `google_play`, `other`), or `history` (read, not owned). |
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
- **Light-scanned only:** `.mobi`, `.azw3`, `.cb7` — listed, parsed by filename, and grouped with
  same-named sibling files by the normal rules (§11.3). Their unknown language never blocks that.
- **`.zip` and `.rar` are comic archives** (the owner confirmed that the zips and rars on the drive
  are comics). The light pass treats them as CBZ and CBR. The deep pass confirms that the archive
  is mostly images in page order. If it isn't (a bundle of other files, software, audio), it's
  dropped from the library and listed in Library health as "archive that isn't a comic". It's
  never extracted (§6.1).
- Anything else is ignored; the scan summary reports counts by type.

### 9.2 Two passes

1. **Light pass** — every reachable folder. Records names, paths, sizes, dates and availability
   (§9.5) **without reading file contents**. The filename parser (§11.1) runs here, so even
   online-only files get a useful guess.
2. **Deep pass** — only files confirmed `present`. Reads metadata (§10), counts words and pages,
   makes a thumbnail, computes the partial hash, and — last, at low priority, on its own time limit
   (§20) — the **full hash**. Both hashes are reused while size and modified time are unchanged.

Each file records which processing stages have run and at which version. A stage is skipped only if
it completed at the current version. **A file that changes from `placeholder` to `present` gets a
deep pass even if its size and date didn't change.** A "Refresh" action re-runs stages after the
parser improves.

### 9.3 Missing, moved and disconnected files

- An **unreachable folder** is skipped and reported ("External drive not connected"), never treated
  as empty.
- A file becomes `missing` **only if its own directory was completely listed in this scan and the
  file wasn't there.** A reachable root isn't enough: a drive unplugged halfway, an access error or a
  cancelled scan leaves the unlisted directories' files exactly as they were (flagged `stale`), never
  missing.
- Missing files **keep all user data**, and become `present` again if they return. If an item still
  has other copies (§11.3), losing one copy changes nothing else.
- **Moves** (a missing file, and a new file elsewhere) use the same evidence as copies, compared on
  whatever both sides have — placeholders were never read, so they have no hashes:
  - **Transfer automatically** when the full filename (with extension, ignoring case) and exact size
    match and no hash (partial or full) disagrees; or, for a renamed file, when size and **full**
    hash match.
  - **Send to Needs review (tier 1)** when only size + partial hash match under a different name, or
    when a hash disagrees. Tier 1 offers "confirm all like this" with a preview, for reorganised
    folders.
  - A similar name alone never moves history.
- **Two present copies are one item with two files** (§11.3), not a move and not a duplicate to
  review.
- Overlapping folders, symlinks and Windows junctions are listed once, with loop protection.

### 9.4 Drive letters change

Store each folder as volume identity + relative path + last-known letter. On scan, if the expected
letter doesn't hold that volume, look for it on other letters (Windows adapter, e.g. PowerShell
`Get-Volume`). Offer **"Reconnect this folder"** for manual repair.

**M0 probe (owner's PC):** `Get-Volume`, `Get-Partition`/`Get-Disk` and `Win32_Volume` all work
without admin rights. Use the volume GUID path (`\\?\Volume{…}\`) as the identity, with the volume
serial as a fallback. Windows reports the USB drive as **Fixed**, so set the folder's storage kind
from the disk's **bus type** (`USB` → external), never from the drive type. Letter changes are still
untested. **Needs checking on the owner's
machine.**

### 9.5 iCloud placeholders

Node's `fs.stat` doesn't expose the Windows attributes that mark online-only files. Read attributes
for a folder in one batch through the Windows adapter (e.g. PowerShell `Get-ChildItem -Recurse -File`
with `Attributes`). Treat `RecallOnDataAccess`, `RecallOnOpen` or `Offline` as **placeholder**, and
any failure to read attributes as **unknown**.

- **Test the bits, not the names.** .NET's `FileAttributes` enum has no names for the recall
  attributes, so PowerShell prints such files' attributes as a bare number. Cast to an integer and
  test `0x00400000` (RecallOnDataAccess), `0x00040000` (RecallOnOpen) and `0x00001000` (Offline).
- **One guard in front of every content reader** (metadata, hashing, thumbnails, PDF rendering).
  Placeholder or unknown → no read.
- **Re-check each file immediately before each content read**, not only at scan time — before the
  metadata read, the thumbnail and the full hash alike, since the hash may run much later. Starting
  PowerShell costs about a second, so never start one per check: keep **one long-lived helper
  process** that takes a path on stdin and returns its attributes in milliseconds. Batch reads (a
  folder at a time) are for the light pass's discovery only and never authorise a content read.
  The remaining gap between check and read is milliseconds; accept it, and note it in the README.
- **Open on a placeholder asks first:** "This file is in iCloud and will download when opened. Open
  anyway?"
- **M0 probe:** the owner's PC has no iCloud and no placeholder files: every book file is plain
  `Archive` (0x20). This section is still built, with fakes, for OneDrive and for other users.
  It can't be confirmed on the owner's machine unless they test an online-only OneDrive file.
- **Needs checking on the owner's machine** with a real online-only file, including what happens when
  a file is downloaded or freed up between scans. Windows is the supported platform; other platforms
  need their own validation.

### 9.6 Cancel and resume

Scans (light and deep) and lookups can be cancelled; they stop after the current file. Cancelling
the light pass exists from M1. Progress is saved per file and
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

- Strip the extension, bracketed release/scanner tags and `(Digital)`. Recognise **quality tags**
  (`HD`, `_hd`, `(HQ)`, `hi-res`, `highres`) — record them on the file and ignore them when comparing
  names, so an HD version groups with its standard version. Pull out volume (`vol1`,
  `v01`, `Vol. 1`), issue (`001`, `#1`), year (`(2012)`) and `Author - Title` / `Title - Author`
  patterns (ambiguous — keep both candidates).
- **Run-together names:** keep the raw form *and* try a word-frequency split
  (`boatofamillionyears` → `boat of a million years`, the "wordninja" approach). The split is a
  fallback guess, not authority — it fails on names and non-English titles.
- **Comparing titles:** lowercase, remove punctuation and spaces, **and strip a leading article
  (the / a / an)** on both sides — otherwise `boatofamillionyears` never matches
  "theboatofamillionyears". Test this rule explicitly.
- Folder names are low-confidence hints (`Comics/Image/Saga/` → publisher Image, series Saga).
- **Rules from the owner's real filenames (M0 probe):**
  - **Download duplicates:** a trailing `(1)` / ` (1)` (a browser's "file already exists" suffix)
    is stripped when comparing names. The raw name is kept.
  - **Size and source tags** are treated like quality tags (recorded, ignored when comparing):
    `optimized` / `opt`, `downsampled`, `high`, `ebook`, `digital`, and a trailing 10-digit
    number after `_` (a Humble id, which looks like a Unix timestamp; never used as a date).
  - **A trailing article** (`…breakthroughsthe`, the library-sort form) is moved back to the
    front, or stripped, like a leading one.
  - **`V1 17`**: a `vN` followed by another number is a *series volume* plus an *issue*, not a
    book volume. A lone `v01` is still a book volume.
  - **Issue files that name their trade:** `Series 012 Vol. 3 Arc Name, May 2, 2006` is issue 12.
    The `Vol. 3` names the collected edition containing it, which is a *suggested* coverage hint
    (§12.5), never the file's own volume.
  - **Issue and volume words:** `_issue1`, `_issue_2`, `issue0`, `freeissue1`, `special_1`,
    `#14`, `vol04`, `vol1_5`, `book1`, `part2`, `tp`, `S2Vol5` (a season). A year joined to a series
    name (`series1992_issue5`) is the series' start year (§8).
  - **Edition words:** `2ndedition`, `fourthedition`, `30thanniversaryedition`, `updatededition`
    → edition number or note. `deluxeedition`, `completecoloredition`, `omnibusedition` → edition
    note, and a hint towards a collected edition.
  - Hyphens or underscores can stand in for spaces (`Series-Name-124`).
- Output each part with how confident it is, and keep the raw name.

Fixture table to grow (add the owner's samples after M1):

| Filename | Expected |
| --- | --- |
| `boatofamillionyears.epub` | title "boat of a million years"; the EPUB's own metadata should win |
| `shadowservice_vol1_darkarts.pdf` | series "shadow service", volume 1, subtitle "dark arts" |
| `Saga 001 (2012) (Digital) (Zone-Empire).cbz` | series "Saga", issue 1, year 2012 |
| `Berserk v01 (2003).cbz` | series "Berserk", volume 1, year 2003 |
| `Clean Code - Robert C. Martin.pdf` | title "Clean Code", author "Robert C. Martin" |
| `saga_vol1_hd.cbz` | series "saga", volume 1, quality HD |

Invented look-alikes of the owner's patterns (M0). The real names stay in `fixtures/private/`:

| Filename | Expected |
| --- | --- |
| `starlanterns_vol3_thelongdark.pdf` | series "star lanterns", volume 3, subtitle "the long dark" |
| `Copperline V2 14.cbr` | series "Copperline", series volume 2, issue 14 |
| `Copperline 012 Vol. 3 Low Tide, May 2, 2006.cbr` | series "Copperline", issue 12; suggested trade "Vol. 3 Low Tide" |
| `Copperline #7.pdf` | series "Copperline", issue 7 |
| `ironharbor1994_issue2.pdf` | series "iron harbor", start year 1994, issue 2 |
| `quietgardens_vol1_optimized_1400000000.pdf` | series "quiet gardens", volume 1; tags `optimized` and a Humble id |
| `pythonrecipes_fourthedition.pdf` | title "python recipes", edition 4 |
| `artofwaitingthe.epub` | title "the art of waiting" |
| `fieldnotes(1).epub` | title "field notes"; compares equal to `fieldnotes.epub` |

Keep some examples **held out** from tuning, so the match report measures real accuracy. Further real
filenames from the owner go in `fixtures/private/`, never in this committed table (§5).

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

Rules, in order. All of them chain: if `book.epub` and `book.pdf` sit together on the hard drive
and copies of both sit in iCloud, all four files end up on one item.

1. **Copies → grouped automatically.** Two files in different folders are the same file — one item,
   several files, no review — when either:
   - their **full hashes match** (whatever their names), or
   - they have the **same filename (extension included, ignoring case) and exact same size**, and
     their full hashes can't be compared because one or both haven't been hashed (placeholders are
     never read, so this is the iCloud case).

   **Any hash that disagrees — partial or full — blocks grouping**, whatever the names and sizes say;
   such files go to rule 3 as a suggestion. A partial-hash match alone never groups. `book.epub` and
   `book.pdf` are never copies of each other — the format rule handles them.
2. **Format group → grouped automatically.** Same folder + same base name (after removing quality
   tags) + different format or quality → one item, several files. This is how Humble and most stores
   deliver one book (EPUB + PDF + MOBI, sometimes an HD version); sending every set to review would
   bury the queue. **Only a known conflict blocks it:** two different *known* languages, different
   abridged flags, or different edition numbers. Unknown never blocks here — MOBI files and many
   PDFs never report a language.
3. **Same base name, different folders, different format or size** (an EPUB here, only a PDF there;
   or a re-issued file with a new size) → a **suggestion** in Needs review, tier 4, with "confirm all
   like this".
4. **Anything else** groups automatically only when a corroborated identifier matches on both.
   Otherwise it's a suggestion.

Editions:

- **Files that differ in language, abridgment or edition number are never merged automatically.**
  They become separate items unless the owner merges them. Each file keeps its own length, and the
  item uses its primary file's length. Outside a format group, an unknown language next to a known
  one is a suggestion, not a merge.
- **A revised edition** (a tech book's 2nd vs 3rd edition) is a separate item. If the owner has the
  newer one, "Still relevant?" suggests Never for the older.
- **Grouping by name starts in M1** (rules 1–2 on name and size only). When the M2 deep pass finds a
  known conflict inside a group — a language, abridgment or edition conflict, or **copies whose
  hashes disagree** — it splits the group automatically if the item has no owner data yet;
  otherwise it lists it in Needs review, tier 1, and it stays grouped until the owner splits it.
  The same check runs whenever a placeholder copy is later downloaded and hashed.

**Primary file** (what Open uses and whose length counts): a present file before a placeholder
before a missing one; then EPUB for prose, the HD version for comics, then other formats.

- A file and a store copy of the same work → one item, two locations.

### 11.4 Needs review

Lists provisional and unidentified items, guessed kinds, uncertain PDF types, cross-folder grouping
suggestions (§11.3 rule 3), and candidate moves. Each row shows the raw filename, embedded
metadata, the chosen candidate and any conflicting fields. Actions:

- **Search and pick**, **Confirm**, **Not this one** (recorded in `candidates_rejected` — never
  re-accepted), **Leave unidentified**, **Fix kind / reference / PDF type**.
- **Merge** and **Split** with a preview **of conflicts only** — e.g. "one is *Halfway*, the other
  *Finished*: keep which?"; for a split, which files, issues and user data go where. Completed
  reading is never credited twice.
- **Undo** works on any of the last 20 merges/splits (`operations` table), not only the newest. Undo
  is offered only if the affected items haven't changed since — edited (progress, rating, note,
  triage…) or touched by a later merge/split. If they have, it offers a **Split** with preview
  instead, so the owner decides where the later changes go — nothing is silently lost. Other edits
  have no undo history.
- **Defer** (hide until a date) and **Dismiss** (accept as is) for anything low-value.

**Order and load.** The queue is tiered, with a count per tier, and works top-down:

1. **Could damage history:** candidate moves, merge conflicts, groups where the deep pass found a
   conflict.
2. **Conflicting identity:** tied candidates, provisional matches with conflicting fields.
3. **Unidentified items that matter now:** shortlisted, in progress, or appearing in recommendations.
4. **Everything else:** guessed kinds, uncertain PDF types, cross-folder grouping suggestions,
   optional improvements.

Rows of the same type offer **"confirm all like this"** with a preview, so a reorganised folder or a
batch of re-issued files is one decision, not hundreds.

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
| **Open Library** | Book search, ISBN, subjects, covers, first publication year | No key. Descriptive User-Agent; about 1 request/second. Cover lookups by ISBN/OLID had a much tighter limit (about 100 per 5 minutes per IP) — **verify**, and prefer covers from the files themselves. |
| **AniList** | Manga: score, tags, genres, volumes, publication status, reading direction | No key. GraphQL. Per-minute limit (90 nominal, lowered to 30 at times) — obey the response headers. |
| ~~Google Books~~ | Dropped | Its terms allow no stored copies beyond each answer's cache header, it has no public review text, and a key is needed in practice. See the end of the [ratings and refresh plan](docs/plans/online-ratings-and-refreshes.md). |
| **Hardcover** | Book ratings + counts, series, genres | Free token from the user's account. GraphQL, labelled beta — expect changes. |
| **Metron** | Comics: series, issues, creators, arcs; possibly collected-edition contents | Free account. Little or no rating data. |
| **ComicVine** | Comics fallback | Free key; unique User-Agent; about 200 requests per resource per hour. |

**Open Library + AniList are the keyless baseline** and come first (M3).

**Hardcover is shown as "Recommended" in first-run setup** — optional and skippable — because
keyless book ratings are thin. Before showing it that way, **verify** that the token works, that the
API returns what we need (ratings, rating counts, series order), that its rate limits suit a few
thousand books, and that its terms allow this personal use. Do this **in M3**: the owner has no
account yet and will create a free one at the start of M3 — **ask them to** (§21). Never ask for the
token in chat. You check the docs and terms yourself; build the adapter against them, then have the
owner enter the token in Settings on their PC and run Diagnostics' **Test Hardcover** check (a few
real lookups from their library, with what came back and the rate-limit headers), and share its
copied report. If it isn't usable, say so plainly and drop the "Recommended" label. Most users won't
have an account, so every screen must read well without it. Diagnostics shows every source's status
("Hardcover: connected", "ComicVine: no key").

**Data coverage by kind.** Stats and Needs review show how much of each kind has a rating, a length
and series information (e.g. "Novels: 62% rated · Comics: 3% rated"), so the owner can see where
picks rest on less data. Expect Western comics to have almost no community ratings with or without
keys.

### 12.2 Ratings

- Store each source's raw score, vote count and scope (book / volume / series).
- Normalise to 0–100 linearly (`score ÷ scale maximum × 100`, so 4.0 of 5 → 80; AniList is already
  0–100), then shrink toward **that source's own average** in proportion to how few votes there are
  (Bayesian average; constants in §20). Don't pool sources into one average — a 4.0 on one site
  doesn't mean the same as 80 on another.
- **"Highly rated" is relative to the source** (§20): a high percentile of that source's shrunk
  scores in this library, because star averages cluster near 4 and a fixed cut-off would pass most
  books from one source and few from another.
- **Your rating and the community rating are shown separately.** Your rating, when present, is what
  the ranking uses.
- Community ratings use the first non-empty tier: trusted item with at least 20 ratings;
  trusted supported series; trusted sparse item; trusted sparse series; provisional-only fallback.
  Within a tier, most ratings wins (unknown below zero), then owner confirmation, this match's
  ISBN evidence, accepted status, match score and a stable source tie-break. Each source record
  counts once in source statistics, even when its series score appears on several volumes.
  **A series score is never shown as a volume's score.** Unconfirmed ratings are labelled and
  never make Hidden gems. The [ratings and refresh plan](docs/plans/online-ratings-and-refreshes.md)
  specifies this Stage 1 and the later per-field details, source-by-source book page and refreshes.
- Display details are selected per field from stored data: owner's title, then Calibre, then
  embedded metadata, then the strongest trusted match, then a filename title. Creators use
  Calibre, the files, then trusted sources. Publication years use the earliest trusted year;
  single issues use cover/store years, never their series' start. Measured pages win, then a
  trusted match to a file ISBN, then the strongest trusted source. Descriptions are compared
  as plain text, preferring a useful Hardcover description (§20). Displayed subjects retain
  trusted/file provenance. This selection never writes matching facts; kind, taste and topic
  inputs remain as before. Stage 3 shows every source's answer on the book page ("From each
  source").
- **Refreshes** (stage 4): while the app runs, small batches (about 25 requests, one per
  ten-minute check) ask sources again: weekly for books in progress or shortlisted, monthly where a
  rating source has no supported trusted rating anywhere, every three months otherwise; failures
  retry after 1, 3 and 7 days. Automatic work uses at most a fifth of a daily allowance and never
  runs in the demo, during a scan or a lookup run. The app remembers the match it accepted;
  later lookups never switch it on their own (a rival goes to Needs review). **Look up again** and
  **Look up all books again** start fresh but keep confirmations, rejections and edits.
- Unknown rating: neutral in the blend; **fails** any "highly rated" filter.

### 12.3 Duration

- **Prose:** words ÷ reading speed for the kind (§20). **Comics/manga:** pages × seconds per page.
  **No word count:** pages × assumed words per page, marked rough. **No page count:** unknown.
- Store a **range** (low–high), the basis ("from 84,000 words"), and the unit (whole book / volume /
  issue). Never apply a series' length to one installment.
- **What counts as a fit** for "Finish within" and One-sitting reads: the length is **measured**
  **and** the high end of its range is within the budget. Measured means a **word count** from the
  file for prose, or a **page count** from the file for comics and manga. Any length built from
  pages × assumed words per page — from a source or from a PDF with no text layer — is always
  **rough** and only appears under "might fit".
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
- **Publication status** (finished / ongoing / unknown) is stored on the series (§7) and is separate
  from what you own: owning every released volume doesn't mean the story is complete.
- **Published volumes** are checked separately, using Hardcover's explicit, numbered, released
  primary works for a confidently matched volume. Show missing published volumes even for an
  ongoing story; never infer them from a book count or create unowned library items. Exclude
  compilations, partial/merged works and future or unknown dates. An unchecked catalogue stays
  unknown. Keep source and check date; failed refreshes retain good data. Normal online lookups
  check each eligible series once, with a manual check/refresh on the item page and no file rescan.

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
Reference items appear only in Skim, topic-interest results and **Still relevant?** (which reviews
tech books whether or not they're reference).

**Availability labels:** "On external drive (not connected)", "In iCloud (not downloaded)", "In
Kindle". These items **stay eligible**. The **Ready to read** filter keeps only items with a present
file or a location the owner has confirmed they can read from. A store name alone doesn't prove the
book is on the iPad.

**Also in iCloud.** A library folder can be marked **"Also in iCloud"** in Settings: the owner keeps
copies of that folder's books in iCloud and reads them on the iPhone and iPad. The owner asked for
this after M0. Its books get the label "Also in iCloud" and count as Ready to read even while the
drive is unplugged. The owner uploaded *most*, not all, so each item has an override:
**Not in iCloud** / **In iCloud** / follow the folder (the default). The flag is owner data. It's
included in backups, and scans never change it.

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
day's file date (a bulk copy), those dates are treated as unknown. "Folder" here is the **library
folder** added in Settings, not each subdirectory: a subdirectory usually holds one bundle
downloaded on one day, so a shared date there is a real date (M0 probe: 114 of 115 large
directories). First-seen dates from the first
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
| Not in the mood | Hides it for this session (like Surprise me's Not today). A **session** lasts until the browser tab is closed (kept in `sessionStorage`); nothing is saved as dislike. |
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
| **Read next** | The blend (§13.7) with the time control. Shows a manageable set (§20), with "Show more", not the whole library. |
| **Continue reading** | In-progress items. **Shortlisted ones first, in shortlist order** (the owner's explicit choice beats the app's inference), then **Nearly done**, Halfway, Into it, Sampled; within each, most recently touched first. |
| **Next in series** | The next eligible owned installment of each series you've started; an unfinished earlier one first. Gaps warn, never block. |
| **One-sitting reads** | Whole works or single installments that **confidently** fit the Finish-within budget (default 2 h). Rating helps but isn't required. Labelled installment vs standalone. |
| **Waiting on your shelf** | Highly rated, not started, not reference, waiting longest. Uses the acquired date (§13.7), labelled with where it came from. Ties broken by rating. |
| **Hidden gems** | Trusted book/volume rating whose own score reaches its source's "highly rated" line and stays above the source's average once adjusted, with at least 3 votes, few for its source and every other trusted source with a known count (§20). Missing data is not obscurity. |
| **Classics you missed** | Highly rated, not started, first published 25+ years ago. The description states the rule. |
| **Still relevant?** | A **review list** for tech books not yet decided here. Order: version-specific titles ("React 16") first, then books outside your topic interests, then oldest first. Shows the signals (version, age, topic match, reference use) as context; it never decides for you. Actions: Want / Mark as reference / Never / Decide later. Old fundamentals aren't treated as stale. |
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
- **Calibre import** (M4), modest and read-only. For people who manage their books in Calibre:
  - The owner points the app at a Calibre library folder (the one holding `metadata.db`). The
    app **copies `metadata.db` into its data folder and reads the copy**, so it never writes to,
    locks or interferes with a running Calibre. Nothing in the Calibre library is changed.
  - **Facts** (title, authors, series and index, ISBN and other identifiers, publisher, tags,
    description) are Calibre-curated metadata: strong evidence for identification (§11.2), with
    the source recorded as Calibre. They never overwrite the owner's corrections.
  - **The owner's own data** comes across only if they choose it in the preview: Calibre's rating
    (stored 0–10, i.e. two per star; 0 means unrated, never "1"), and "read" status from a
    custom column the owner picks (Calibre has no built-in one). Dates come from a date column
    the owner picks, else they stay unknown.
  - **Matching:** a Calibre book's files are matched to scanned files by path when the Calibre
    library is (or is inside) a scanned folder, then by full hash, then by identifiers with
    title/author corroboration. Unmatched Calibre books without files on disk can be kept as
    unverified store-style items or skipped. Preview, conflicts and repeatability as for other
    imports.
  - **Verify** the `metadata.db` schema (books, authors, series, ratings, identifiers, custom
    columns) against a current Calibre version when building it.
- **Imports are repeatable**: re-importing the same file doesn't duplicate anything or overwrite
  owner edits. Rows are recognised by ISBN when present, otherwise by normalised title + author +
  store.
- **Open** and **Show in folder** take an item or file **id**, never a path. Check the file is present
  first (placeholder → confirm, §9.5). Use argument-safe launching (Windows: `explorer /select,` and
  the default-app handler; `open` / `xdg-open` elsewhere). Behind the platform adapter — **needs
  checking on the owner's machine.**
- **Store items** show **Read in Kindle ↗** etc. as a **link** to the book in that store's web reader
  or store page, when one is known (owner decision 2026-11-11, replacing "a label, not a link"; rules in
  [the store purchases plan](docs/plans/get-store-purchase-imports.md), "Store links").

## 15. Pages and statistics

| Page | Contents |
| --- | --- |
| **What next** | The ten modes, time control, filters (Ready to read, Complete stories only), cards with reasons, limitations and gap warnings. |
| **Library** | Sort by rating, length, effort, acquired/first-seen date, publication year, last touched. Filter by kind, reference, format, location, availability, progress, triage, length, genre, effort, folder. URL state; group by series; smooth at 5,000 items. |
| **Item detail** | Metadata with its sources, files with edition details, locations, progress, rating, note, takeaway, overrides, series order with coverage and gaps. |
| **Triage** | §13.5. |
| **Shortlist** | §13.9. |
| **Needs review** | §11.4 tiers and actions, match quality header (§11.5), data coverage by kind (§12.1), Library health. |
| **Library health** | Unreadable or corrupt files, scanned PDFs with no text, copy counts across folders (informational), ignored formats — errors kept apart from merely incomplete metadata. |
| **Stats** | Data coverage by kind (rated / length known / series known), backlog count and estimated hours by kind (with **how much of the backlog has a known length**), finishes per year, this year vs last, read rate by kind and by folder (denominators stated), DNF reasons, Never totals, your ratings, taste signals, match summary, takeaways. |
| **Settings** | Folders (last seen, last complete scan, Scan now, Reconnect), stores and imports, API keys, reading speeds and time presets, topic interests, Tune, backups, Diagnostics. |
| **Diagnostics** | Plain-language checks any user can run: each folder's drive found (and as which letter), iCloud online-only files detected correctly (counts by state), Open works on a chosen file, each source's status and last error, database version and last snapshot, Node version. **Copy report** gives plain text with no API keys; filenames are included only if the user ticks a box. This page grows out of the Milestone 0 probe. |
| **First run** | Add a folder → scan → optional short triage → recommendations. No keys required. |

**Stats separate facts from estimates.** Books finished on unknown dates are listed separately, not
counted in any year. Progress buckets can't give exact pages read, so don't show such numbers.
Never and reference items are left out of backlog totals but stay in the Library.

## 16. Backup and restore — from M1

- **JSON backup** of everything except book files, covers and secrets: series, items, files, issues,
  coverage, locations, user data, aliases, cached field sources, settings. Versioned; extended as
  each milestone adds tables.
- **Restore replaces all app data** — it never merges into what's there. It works without
  rescanning or connecting any drive: store-only, history-only and unavailable-file items come back
  with their original ids. Before applying, preview what will be replaced (counts, and anything
  changed since the backup was made).
- Later scans **reconnect files cautiously** (same rules as moves, §9.3). Anything unresolved stays
  unresolved; nothing is lost. Fuzzy titles never reattach progress.
- Validate the file before applying, apply in one transaction after a pre-restore snapshot (kept
  apart from the pre-migration snapshots, so neither pushes the other out). **Test that a corrupt
  restore rolls back.**
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
- The demo must include: one book in several formats (including an HD comic next to its standard
  version), the same files in two folders (one copy online-only), two editions that must stay separate (a
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
12. Placeholder and unknown files never reach a content reader — including a file that becomes
    online-only after its folder was listed, or between its metadata read and its later full hash
    (asserted with fakes; real behaviour checked on Windows).
13. A merge shows conflicting user data, and undo restores the exact prior state — including after
    several later merges of other items.
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
25. The same EPUB and PDF on the external drive and in iCloud (online-only) become one item with four
    files and nothing in Needs review; Open uses a downloaded copy; unplugging the drive leaves the
    item labelled "In iCloud (not downloaded)" with its progress intact.
26. `book.epub` in one folder and `book.pdf` in another are suggested as one item, never grouped
    silently; an HD and a standard CBZ of the same issue in one folder group automatically, with the
    HD file as primary.
27. Two files with the same name and size whose hashes disagree are never grouped as copies; if they
    were grouped by name in M1, the deep pass splits them (or, if the item has owner data, sends it
    to Needs review tier 1).

### 17.2 Recommendation quality sessions (with the owner)

Tests prove the app is correct; only the owner can say whether its picks are good. Twice — after M3
and at M6 — the owner spends about 20 minutes with the app on a real slice of their library (a few
hundred items):

1. Ask for picks in real situations, for example: "30 minutes tonight", "something I can finish this
   weekend", "continue a comic", "I want to learn something", "surprise me".
2. For each, record whether **the top 5 include something the owner would actually start this
   week**, what had to be corrected first, and why the rest were rejected (the `pick_feedback` log
   captures most of this).
3. Write the full results to `docs/private/quality-sessions.md` (gitignored — it names the owner's
   books), and a **title-free summary** of findings to `docs/quality-summary.md` (committed). Then
   decide what to fix: matching, data coverage, weights or modes.

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
- Reports raw attribute **numbers** as well as decoded flags (§9.5), so the bit tests can be checked
  against real files.
- Reports how many filenames appear in more than one folder with the same size (copies, §11.3), and
  how many share a base name with a different extension or a quality tag.
- Optionally lists a random sample of up to 300 filenames (names only). The owner can edit them
  before sharing.
- **Never opens file contents, never writes anywhere except its own report file**, which goes next to
  the script, never into a library folder. Runs PowerShell with `-NoProfile -ExecutionPolicy Bypass`
  for this script only, and says so at the top of the `.bat`.
- Lives in `tools/probe/`. The owner shares the report in chat; it's never committed (§5).

**Done when:** the owner has run it and shared the report; the platform fakes and filename fixtures
(private ones in `fixtures/private/`) are updated to match it; and the plan's Windows assumptions
(§9.4, §9.5, §11.3 copies) are confirmed or corrected in the milestone notes.

### M1 — Library and tracking

- Repo, workspaces, TypeScript, CI, localhost binding with the request checks (§6.3),
  `start-whatBooksNext.bat` (checks the Node version and that the port is free, and says what to do
  if not).
- Migrations with consistent snapshots (§6.2).
- `LICENSE` (PolyForm Strict 1.0.0) and the `.gitignore` entries for `data/`, `fixtures/private/`
  and `docs/private/` (§5).
- Folders, Windows adapters with fakes (volumes, attributes via the long-lived helper, launching),
  **light pass** with the directory-coverage missing rule, placeholder detection and cancel.
- Filename parser with fixtures, including quality tags.
- Grouping by name and size: copies and format groups (§11.3 rules 1–2), so items are right before
  the owner adds progress to them.
- Library and item detail; manual title/kind corrections.
- Progress, DNF reasons, dates with precision, rating, note; shortlist; Open / Show in folder.
- JSON backup and restore without rescanning, with the backup-coverage test (§16). Demo mode.
- First version of Diagnostics (drives, placeholders, Open).

**Done when:** a fresh clone runs; scan a fixture folder → fix a title → set progress → shortlist →
back up → restore into an empty app with no folders connected, all intact. An unreachable folder is
skipped, not emptied. Scenarios 10, 14 (light-pass level) and 21 pass.

**After M1:** ask the owner for more real filenames — especially HD versions and EPUB/PDF pairs — and
add them to `fixtures/private/` and its held-out examples.

### M2 — Deep scan and file identity

- EPUB / CBZ / CBR / PDF readers; thumbnails, word and page counts; PDF type with "uncertain".
- Worker pool with limits; the single content-read guard with re-check; placeholder → present
  transitions.
- Partial/full hashing, moves (§9.3), copies by full hash, the conflict check (edition, language,
  disagreeing hashes) on groups made in M1, cross-folder suggestions.
- Deep-pass cancel and resume, per-folder scan reminder, Library health.

**Done when:** scenarios 11, 12, 15, 17, 24, 25, 26 and 27 pass; a confirmed move keeps progress, an
ambiguous one goes to review; resuming skips completed stages; benchmark numbers recorded.

### M3 — First real recommendations

- Source adapter interface, `source_cache`, rate limits, circuit breakers.
- **First, ask the owner to create a free Hardcover account** (§21). Build the adapter, then have the
  owner enter the token in Settings and run Diagnostics' Test Hardcover check (§12.1).
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

- Metron and ComicVine adapters (each optional, verified against current docs). Google Books was
  dropped (§12.1).
- Series runs and issues, collection coverage (suggested/confirmed) and its shared reading state
  (§12.5), gaps on cards, publication status.
- Merge/split with conflict preview, the undo stack and the "edited since" rule.
- Store titles (search, manual, CSV); Goodreads/StoryGraph import; **Calibre import** (§14),
  read-only from a copy of `metadata.db`.

**Done when:** scenarios 3, 4, 13, 19 and 20 pass; imports can be repeated without duplicates (including a
Calibre import that leaves the Calibre library untouched); dates keep their
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

**Done when:** all 27 scenarios pass; **the owner's second quality session (§17.2)** meets its target
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
3. **Automatic Calibre sync** — keep whatBooksNext in step with a Calibre library as it changes,
   instead of re-running the import (§14). Deferred: the import covers the need, and two-way sync
   would make the app a second library manager.
4. **Kindle for PC library cache** — investigate whether a local list of owned books can be read. No
   promises; search and manual entry remain the fallback.
5. **Optional AI** — opt-in summaries from a book's opening, or "more like this" by text similarity,
   only after ordinary recommendations work well, and only if they measurably help.
6. **Easy install for everyone** — a normal double-click Windows installer, so users don't need to
   install Node or run commands. Check the options when the time comes (e.g. a packaged Node
   executable vs a desktop wrapper) and pick the lightest that works.
7. **Mac and Linux support** — real platform adapters (drive identity, cloud placeholders such as
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
| Fingerprint | size + SHA-256 of first and last 64 KB (partial); full SHA-256 of every present local file, computed once in the deep pass and reused while size and modified time hold | The partial hash is cheap; the full hash must already exist for a file that later goes missing, or a move can't be confirmed. |
| Full-hash time limit | None per file, but cancellable, resumable and run last at low priority | Hashing a large file on a slow external drive legitimately takes longer than the 60 s parse limit. |
| Copy match | Full hashes match; or, when full hashes can't be compared, same filename (extension included, ignoring case) + exact byte size. Any disagreeing hash blocks it. | Owner-approved: an identical name and size is the same file when nothing contradicts it. Placeholders can't be hashed. |
| Rating shrinkage | Prior weight = **median vote count for that source in this library**; prior mean = that source's mean in this library; one sample per eligible `source:sourceId` target | Adapts to each source's audience size instead of guessing a constant. |
| "Highly rated" | At or above the **70th percentile** of that source's shrunk scores in this library; with fewer than 30 rated items from that source, ≥ 80 / 100 instead | Star averages cluster near 4 / 5, so a fixed cut-off passes most books from one source and few from another. The fallback covers small libraries. |
| Useful description (`DESCRIPTION_USEFUL_CHARS`) | 200 plain-text characters | Assumption: prefer a useful Hardcover description; shorter ones compete by visible-text length after stripping formatting. |
| Supported rating (`RATING_SUPPORTED_VOTES`) | 20 ratings | Assumption: separates noisy item scores from supported series fallbacks; calibrate against the owner’s library. |
| Hidden gems | Trusted book/volume rating; its own score reaches the source's "highly rated" line and stays above the source's average once adjusted; at least 3 votes; "few" = the bottom half for its source here or 25 votes, whichever is higher; every other trusted known count is also few for its source | Loosened 2026-11-11: the owner's library had none, because the adjusted score pulls few-vote books to the average and its bottom-25% line fell below 5 votes. 1–2 votes are noise. Assumptions. |
| Read next list size | 10 cards, "Show more" adds 10 | Enough choice without becoming the Library. |
| Classics age | 25 years since first publication | A generation old; long enough for reputation to settle. |
| Ranking weights | rating 0.35, time fit 0.20, taste 0.15, momentum 0.15, triage 0.10, recency 0.05 | Ratings lead; recency stays a nudge. Adjustable under Tune. |
| Taste threshold | 10 explicit outcomes (rated, finished, or DNF "Not for me"), counted **after** the series cap, from at least 3 different authors or series | Fewer is mostly noise, and ten books by one author teach one thing, not ten. |
| Match tie margin | 0.05 | Closer than this, the "winner" is a coin flip. |
| Recency boost | Acquired within the last 60 days; a library folder (as added in Settings, not each subdirectory) where over 50% of files share one day's file date is treated as a bulk copy (dates unknown) | New purchases get a look; a bulk copy isn't a purchase date. One bundle downloaded on one day is a real date, not a bulk copy. |
| Surprise me | Random from the top 50 of Read next, probability ∝ score² | Favours good picks while still surprising. |
| Worker pool | CPU cores − 1, at most 4 workers; each with a 1 GB JavaScript heap cap, sharp cache off and concurrency 1 | Keeps the PC usable during a deep scan; large PDFs need headroom. The heap cap alone doesn't limit native memory (§6.1). |
| Taste series cap | A series counts as at most 2 items of evidence | Stops one long series dominating. |
| First triage session | 15 items | Enough to help, short enough to finish. |
| Scan reminder / snooze | 30 days / 7 days | Monthly, as the owner asked. |
| Still reading? / snooze | 90 days / 30 days | A quarter untouched usually means stalled. |
| Undo stack | Last 20 merges/splits | Covers a cleanup session. |
| Published-volume catalogue | Refresh after 7 days; at most 500 positions and 100 series memberships | Weekly checks avoid repeated requests per owned volume; bounds stay below Hardcover's documented 997-row relation limit and refuse truncated answers. |
| Refresh intervals (`REFRESH_*_DAYS`) | 7 days in progress or shortlisted; 30 days where a rating source has no supported trusted rating anywhere; 90 days otherwise; each stretched by up to 10% per book | How likely an answer has changed; the stretch stops books looked up on one day falling due together. Assumptions. |
| Refresh retries (`REFRESH_RETRY_DAYS`) | 1, 3, 7 days, then the group's interval | A site hiccup is retried soon; a lasting problem isn't asked about daily. |
| Refresh batch (`REFRESH_BATCH_REQUESTS`, `REFRESH_CHECK_MS`) | About 25 real requests per check (checked before each book; a source's retry can add one or two); first check 3 minutes after start, then every 10 minutes | Background work stays small; a long time closed is caught up gradually. |
| Automatic share of a daily allowance (`REFRESH_DAILY_SHARE`) | 20% (1,000 of Hardcover's and Metron's 5,000) | Leaves most of the allowance for the owner's own lookups. |
| Pre-migration snapshots kept | 5 | A few versions back, without filling the disk. |
| Pre-restore snapshots kept | 3, separately | A restore must never push out the migration snapshots, or the other way round. |
| Server port | 4818, overridable with `PORT` | Unlikely to clash with common dev tools. |
| Opening-page preview size (`PAGE_PREVIEW_MAX_SIDE`) | 1,000 px maximum side | Enough to compare title and credit pages when enlarged without rendering full-resolution scans. Generated on demand, two pages per file. |
| Per-file limits | 60 s (parsing, counting, thumbnails — not full hashing); uncompressed ≤ 4 GB; compression ratio ≤ 100:1; images ≤ 50 megapixels | Large comic archives are fine; zip bombs and runaway files aren't. |
| Light-scan target | 5,000 files in under 30 s on a local SSD | A goal to measure against, not a claim. |
| Store collectors: gap between requests | 2 s | Store purchases plan, "Account safety": about a person's pace on their own library page. |
| Store collectors: longer pause | 30 s after every 50 requests | Same: no long bursts. |
| Store collectors: requests per scan | at most 300 | 15,000 books at 50 a page, far beyond a personal library; reaching it stops the scan as partial. |
| Store collectors: stalled pages | 2 in a row with nothing new | Stops a list that repeats itself instead of looping. |
| Store purchases: "far fewer books" warning | more than 20% fewer than the last complete scan | A real library rarely loses a fifth of its books between scans; a broken collector easily does. |

## 21. Owner actions and things still to confirm

### Owner actions — tell the owner when each is due

The owner asked to be told whenever they need to do something. When one of these comes up, say so
plainly at the start of your message, with what to do and roughly how long it takes.

| When | What the owner does |
| --- | --- |
| **M0** (before any app code) | Run `tools/probe/whatbooks-probe.bat`, name 2–3 files known to be online-only in iCloud, and share the report in chat. |
| **After M1** | Send more real filenames — especially HD versions and EPUB/PDF pairs. |
| **Start of M3** | **Create a free Hardcover account** and generate an API token (about 5 minutes). Once the adapter is built, enter the token in the app's Settings (never in chat), run Diagnostics → Test Hardcover, and share the copied report. Decides whether Hardcover can be labelled Recommended. |
| **End of M3** | First ~20-minute recommendation quality session (§17.2). |
| **During M1–M6, as they come up** | Check the "needs checking on the owner's machine" items on the Windows PC. For ratings Stage 1, open the CSV in Excel to check the appended scope/match columns, accents and formula text; inspect Diagnostics tier counts. For Stage 2, spot-check chosen titles/creators, page provenance and conflicting years, including Unicode and Calibre-formatted descriptions. No new accounts or keys. |
| **End of M6** | Try installing from the README as a stranger would. The second quality session moves to after stage 3 of the [ratings and refresh plan](docs/plans/online-ratings-and-refreshes.md), so it judges the new ratings and details. |
| **Store purchases: Stage 0** | Done: over 12 books in each store (2026-11-11). |
| **Store purchases: Kindle** | Done 2026-11-11: A2 (complete scan, 155 found) and A3 (import). A1b (store links) works too. The extension is deferred (owner decision 2026-11-11). |
| **Store purchases: look around** | Done 2026-11-11 (A6) for Google Play Books, Kobo and GlobalComix. |
| **Store purchases: Google Play Books** | Done 2026-11-11 (version 2: 23 found, imported). |
| **Store purchases: Kobo** | Done 2026-11-11 (script run and imported). |
| **Store purchases: GlobalComix** | Done 2026-11-11 (version 2, imported). To update any store later: run its script again from Settings → Import store purchases. |
| **Store purchases: bookmark buttons (when convenient)** | In Settings → Import store purchases, pick each store and drag its **whatBooksNext: …** button to your bookmarks bar (Ctrl+Shift+B shows the bar). From then on, click the bookmark on the store's page instead of pasting into the console. Drag them again after an update. |
| **Now (after stage 4)** | The second quality session (§17.2), on the new ratings and details. Also, on the Windows PC: Settings → Online lookups → **Keeping ratings up to date** shows due books and a last batch after the app has been open 10–15 minutes; Diagnostics → Automatic refresh shows requests within the daily share. No new accounts or keys. |

### Still to confirm (not blocking)

- ~~The M0 probe report~~: done. iCloud placeholders couldn't be tested (no iCloud on the PC).
  The owner's answers to its follow-up questions: no books in OneDrive; the `.zip`/`.rar` files are
  comics (§9.1); a folder can be marked "Also in iCloud" (§13.1).
- Later on the owner's Windows PC: drive letter changes, download transitions, Open / Show in folder.
- **Other storage places.** The owner's books are all on one external drive (no OneDrive books).
  For other users, OneDrive uses the same placeholder mechanism as iCloud and should work the same
  way. Dropbox, a second external drive or a network drive each need checking when they come up.
- Hardcover's suitability (§12.1) before it's labelled Recommended; other optional keys if the owner
  wants them (Metron, ComicVine).
- The two owner quality sessions (§17.2).
- Reading speeds and thresholds, once there's real use to calibrate against.
- Each source's current access rules and export column names, when its adapter is built.
- Calibre's `metadata.db` schema and custom columns, when the Calibre import is built (M4).

No further product decisions are needed to start M0 and M1.
