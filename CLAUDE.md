# Notes for AI agents working on whatBooksNext

Read **`PLAN.md`** first. It is the spec: what to build, in what order, and the decisions the
owner has already made. Don't reopen those decisions. Then read the latest
**`docs/milestones/M*.md`** for where things stand.

## Where things stand

- **M0–M3** are done and checked on the owner's PC (M3: first real recommendations; Hardcover
  verified; quality session passed, `docs/quality-summary.md`).
- **M4 in progress** (`docs/milestones/M4.md`). Part 1 (series and gaps) and part 2 (Metron and
  ComicVine adapters) are built. Part 2 waits on the owner's Test Metron / Test ComicVine
  reports (done: shapes confirmed, many ties; tie-breakers added). Record real answers into
  `fixtures/sources/` when the owner can share some. Part 3 (collected
  editions: `collection_coverage`, `lib/coverage.ts`) is built. Part 4 (merge/split with
  undo, `lib/operations.ts`) is built. Parts 5–6 (store titles +
  CSV, `lib/store.ts`; Calibre, `lib/calibre.ts`) are built. Part 7 (Goodreads/StoryGraph,
  `lib/historyImport.ts`) is built. Windows checks and fresh authenticated export verification
  remain open in the M4 notes.
- **M5 built** (`docs/milestones/M5.md`): the ten modes (`server/src/lib/modes.ts`, one shared
  pool), taste learning (`lib/taste.ts`, pure), Tune and topics (`lib/tune.ts`, in `settings`),
  Still reading?, triage sources and bulk triage (`routes/modes.ts`).
- **M6 built** (`docs/milestones/M6.md`): Stats (`lib/stats.ts`, pure), CSV export
  (`lib/export.ts`), full snapshots (`lib/fullSnapshot.ts`), restore regression across every
  table (`app.release.test.ts` — a new table must get a row there), Diagnostics' last Open, the
  accessibility sweep in `npm run screenshots`, README for a stranger. Open: the owner's second
  quality session and a stranger-install try (§21); Windows checks in the M4/M6 notes.
- **Ratings Stage 1 built:** scope/trust/vote selection, source-target statistics, honest Hidden
  gems, export evidence and Diagnostics tier counts; see the Stage 1 section of `docs/milestones/M6.md`.
- **Details Stage 2 built:** `lib/details.ts` selects display facts per field without writing
  matching inputs. Original ranking title/creators and subject pools keep taste/topics unchanged.
- **Next:** `docs/plans/online-ratings-and-refreshes.md`: a "From each source" book page, then automatic refresh. One pull request per
  stage, in order. Google Books was dropped; the plan says why.
- Series rows are rebuilt by `syncSeries` (`server/src/identify/series.ts`) from stored facts
  and owner corrections. Call it after anything that changes items' names, numbers, kinds or
  matches. Gap rules are pure, in `server/src/lib/series.ts`.
- Content reads go through `server/src/scan/guard.ts` only. Raise a stage in `STAGE_VERSIONS`
  (`server/src/scan/deepPass.ts`) when its reader changes, so the next scan re-reads files.
- Online sources live in `server/src/sources/`, one polite client each (rate limit, cache,
  circuit breaker). Tests replay `fixtures/sources/`; never call the network in tests. Raise
  `MATCH_VERSION` (`server/src/identify/match.ts`) when scoring changes: the next lookup
  re-scores from the cache without new requests. `npm run report:matches` must keep 0 wrong
  high-confidence matches.
- Ranking is pure (`server/src/lib/recommend.ts`); `lib/rankData.ts` assembles its input.
- API keys go in the `secrets` table only, never in settings, backups or Diagnostics.
- The **owner actions** for each milestone are in PLAN.md §21. Tell the owner, plainly and at
  the start of your message, whenever one is due.

## Hard rules

- **The repo is public. The owner's library stays out of it** (PLAN.md §5). Never commit real
  filenames, the probe report, the owner's backups or anything derived from them that names
  books. Tests and fixtures use **invented** names that copy the real patterns. If the owner
  shares filenames or a backup, analyse them only in your scratch area, and record title-free
  summaries (counts and patterns) in the milestone notes.
- **Read-only on the library.** Nothing writes into library folders. No content read happens
  unless the file is confirmed present by a fresh attribute check (§9.5).
- **Unknown is unknown.** Never invent ratings, dates, ids or lengths, even in the demo.
- **Owner corrections win.** Scans and lookups never overwrite `user_item` data.

## Working on the code

- Node ≥ 24. The server is TypeScript run directly by Node's type stripping: use erasable syntax
  only and `.ts` import extensions. No server build step.
- `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check` must all pass. CI
  runs them on Ubuntu **and Windows**. `npm run build` builds the web UI.
- Tests are sentences (`it("keeps a book's progress when its file moves")`). Route-level tests
  run against in-memory SQLite (`server/src/testing/helpers.ts`).
- **Check in a real browser:** `npm run screenshots` drives the demo library in Chromium (light
  and dark, desktop and phone). Look at the screenshots before calling UI work done.
- Windows-specific code lives behind `server/src/platform/`: a long-lived PowerShell helper, a
  generic fallback, and a fake for tests and the demo. Passing the fake proves nothing about
  Windows, so list such behaviour in the milestone notes as "needs checking on the owner's
  machine".
- **Schema changes:** add a new numbered file in `server/src/db/migrations/`. Never edit
  `001_init.sql`, because the owner's database is already on it. Add every new table to the
  backup or to its commented exclusion list (`server/src/lib/backup.ts`); a test enforces it.
- **Filename parser:** raise `PARSER_VERSION` in `server/src/identify/filename.ts` whenever its
  rules change. The next scan then re-reads names and refreshes titles taken from filenames.
- Every tunable number comes from PLAN.md §20 and lives in `server/src/config.ts`, with its
  reason.
- `.npmrc` sets `ignore-scripts=true`: better-sqlite3 ships prebuilt binaries, and npm's
  automatic compile step breaks on PCs without Visual Studio. Check before adding a dependency
  that needs an install script.
- `.bat` files are stored with CRLF (`.gitattributes`). Everything else is LF.

## The owner

The owner runs Windows 11, with one external USB drive (`E:\My Books and Comics`) and no iCloud
on the PC. They read on an iPhone and iPad. They aren't a programmer: give steps that need no
command line wherever possible (see `INSTALL.md`). They asked to be told plainly whenever they
need to do something.
