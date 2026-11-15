# Review fixes and improvements (November 2026)

A plan for an agent to implement. It comes from a code review on 2026-11-15 at commit `7217744`.
Every bug below was reproduced against an in-memory app unless it says "read, not reproduced".

Read `CLAUDE.md` and `PLAN.md` first. Their rules apply to everything here: invented names in
tests, no network in tests, read-only on the library, owner corrections win, tunable numbers in
`server/src/config.ts`.

## How to work through this

- Do the stages in order. Each stage is one commit (or one pull request) that passes
  `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check` by itself.
- For every bug: write the failing test first (a sentence, as the repo's tests are), see it fail,
  then fix it.
- Stage 1 changes two pages. Run `npm run screenshots` and look at the Library and Settings
  pictures before calling it done.
- Line numbers are from commit `7217744` and may have moved. Find the code by name.
- Stop and ask the owner rather than guess at anything listed under "Owner decisions".
- When a stage is done, tick it here and add a short note to `docs/milestones/M6.md`.

## Owner decisions

These change what the owner sees. Each has a default the agent may build if the owner hasn't
answered, but the summary must say which default was used.

| #   | Question                                                                        | Default                                                             |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1  | A reading date in the future: refuse it?                                        | Refuse, with a plain message.                                       |
| D2  | A start date after the finish date: refuse it?                                  | Refuse only when both dates are exact days.                         |
| D3  | A finish date typed on a book that isn't marked finished: refuse, or mark it?   | Refuse: "Mark the book finished first."                             |
| D4  | Folders already nested in the owner's library (if any): what happens to them?   | Leave them alone; show a warning in Library health. Never auto-fix. |
| D5  | StoryGraph dates written with slashes (`03/04/2024`): day first or month first? | Don't change anything until a real export shows which.              |

## Stage 1: Bugs the owner can hit

**Done** (2026-11-15). Notes in `docs/milestones/M6.md`.

### 1.1 The Library stops at 1,000 books

- **Now:** "Show 100 more" raises `limit` by 100 each time (`web/src/pages/Library.tsx`, the
  `/api/items?...&limit=` request). The server caps `limit` at 1,000 (`queryLibrary` in
  `server/src/lib/library.ts`). With 1,150 books the button stays and does nothing.
- **Fix:** page with `offset`. The page asks for the next 100 (`offset = items.length`,
  `limit = 100`) and appends them. A change of filter, search or sort starts again from 0. Keep
  the server's cap.
- **Watch for:** the stale-answer guard already in that effect must cover appended pages too, so
  a slow answer for an old filter is never appended to a new list. `toggleShortlist` edits the
  list in place and must keep working.
- **Tests:** a `queryLibrary` test that offset 1000 of 1,150 returns the last 150. A route test
  for the same through `/api/items`.

### 1.2 A folder inside another library folder is accepted

- **Now:** `addFolder` (`server/src/scan/folders.ts`) refuses only an exact duplicate. Adding a
  folder and then one of its subfolders records every file in the subfolder twice.
- **Fix:** refuse a folder that is inside an existing library folder, or that contains one. Say
  which folder, in plain words. Compare resolved paths without regard to case, on whole path
  segments (`E:\Books2` is not inside `E:\Books`).
- **Also here:** the data-folder check compares with exact case and doesn't catch a parent of
  the data folder. Make it ignore case, and refuse a folder that contains the data folder.
- **Existing nested folders (D4):** don't remove or merge anything. Add a Library health line
  that names the two folders and says to remove one.
- **Tests:** nested inside, containing, same prefix but a different folder, different case,
  data folder in a different case, parent of the data folder.
- **Needs checking on the owner's machine:** drive-letter and UNC paths on Windows. List it in
  the milestone notes.

### 1.3 "Reconnect this folder" takes any path

- **Now:** `reconnectFolder` (same file) resolves a relative path against the app's own folder,
  and skips every check `addFolder` makes.
- **Fix:** share one path check between the two: absolute path, exists, not the data folder, not
  a duplicate of or nested with another library folder (the folder being reconnected is left out
  of that comparison).
- **Tests:** relative path refused; path of another library folder refused; a valid move still
  works and files keep their ids.

### 1.4 Impossible reading dates are saved

- **Now:** `applyUserPatch` (`server/src/lib/progress.ts`) accepts a finish date on a book that
  isn't finished, dates in the future, and a start after the finish. `isCalendarDate` only checks
  the date exists. A future year then appears in Stats.
- **Fix (per D1 to D3):** check the row as it would be after the patch, and only the fields the
  patch touches, as the existing "exact needs a day" check does, so an older record never blocks
  an unrelated edit.
  - Future: compare against `today` (already a parameter). A month or year is in the future only
    when the whole month or year is.
  - Start after finish: only when both are full days.
  - Finish date without finished progress: refuse.
- **Don't break:** history import (`lib/historyImport.ts`) and store import go through
  `applyUserPatch`. An imported row with a bad date must be reported as a problem for that row,
  not fail the whole import. Check how each caller handles a thrown `HttpError`.
- **Existing bad dates:** leave them. Don't write a migration that edits `user_item`.
- **Tests:** one per rule, plus "an older impossible date doesn't block changing the rating".

### 1.5 Library page error handling

- **Now (read, not reproduced):** in `web/src/pages/Library.tsx` an error is never cleared after
  a later load succeeds; the `.catch` doesn't check the stale flag; `toggleShortlist` and the
  `/api/folders` load have no error handling.
- **Fix:** clear the error on success, ignore stale failures, show a plain message when the
  shortlist toggle or folder load fails. Use the existing `Notice` and Retry patterns from
  PR #23 rather than new ones.

## Stage 2: Plain answers instead of crashes

**Done** (2026-11-15). Notes in `docs/milestones/M6.md`.

Small, server-only.

- **2.1** `GET /api/items?sort=__proto__` answers 500. In `queryLibrary` look the sort up with
  `Object.hasOwn` (or a `Map`) so an unknown sort is the existing 400.
- **2.2** Restore preview answers 500 when the backup's `createdAt` isn't text. In
  `validateBackup` (`server/src/lib/backup.ts`) require `createdAt` to be a string that parses as
  a date; otherwise the usual "isn't a whatBooksNext backup" 400.
- **2.3** Ctrl+C twice runs `shutdown` twice in `server/src/main.ts`. Guard it with a flag and
  log, rather than throw, if closing fails.
- **Tests:** one route test each for 2.1 and 2.2.

## Stage 3: Guard rails

**Done** (2026-11-15). Notes in `docs/milestones/M6.md`. Two owner answers changed the plan:
Open Library cover redirects may go to archive.org (3.2), and depth skips show in Settings → Last
scan (3.4).

- **3.1 Match report in CI.** `CLAUDE.md` requires 0 wrong high-confidence matches from
  `npm run report:matches`, and nothing enforces it. Add a test that runs the same report over
  `fixtures/sources/` and fails on any. First read `scripts/reportMatches.ts` to see how it
  counts them; reuse its code, don't copy it.
- **3.2 Cover downloads don't follow redirects off the list.** `SourceClient.image`
  (`server/src/sources/client.ts`) follows redirects anywhere. Fetch pictures with
  `redirect: 'manual'` and follow at most a few hops by hand, each checked with `sourceCoverUrl`
  for that source. `Fetcher` (`sources/types.ts`) may need to pass `redirect` through; check the
  test fetchers still work. Also refuse early when `Content-Length` is over the limit, before
  reading the body. A refused redirect must not count toward the pause after failures (pictures
  never do).
- **3.3 ISBN check digits.** `normIsbn` (`server/src/lib/store.ts`) accepts any 10 or 13 digits.
  Add the ISBN-10 and ISBN-13 checksum. Find every caller first (store CSV, history import,
  Calibre, store purchases): a row whose ISBN fails becomes "no ISBN" plus a problem line where
  the importer has one, never a refused row. Check that fixtures and the demo use valid ISBNs
  and fix invented ones that don't.
- **3.4 Folders skipped for depth.** `lightScanFolder` (`server/src/scan/lightPass.ts`) silently
  stops at `MAX_SCAN_DEPTH`. Count them in `FolderScanSummary` and say so where the scan result
  lists errors and skipped links. Counts only, no folder names in Diagnostics without `names`.

## Stage 4: Tests for the web pages

There are none; pages are checked only by screenshots.

- Don't add a new test framework without asking. Vitest is already here. A DOM environment
  (`jsdom` or `happy-dom`) and `@testing-library/react` would be new dev dependencies: check
  they need no install script (`.npmrc` sets `ignore-scripts=true`) and say so in the summary.
- Start with three tests that would have caught Stage 1: Library paging appends and resets,
  an error clears after a good load, and a failed shortlist toggle shows a message.
- Keep them out of the server's test run time if they are slow.

## Stage 5: Tidying (only if asked)

No behaviour changes. Each is its own commit, and none should be mixed with a fix.

- Split the largest files along seams that already exist: `server/src/identify/lookups.ts`,
  `web/src/pages/StoreBooks.tsx`, `web/src/pages/WhatNext.tsx`, `server/src/app.ts` (folders,
  covers, backup and diagnostics routes could move to `routes/` like the others).
- Shorten "Where things stand" in `CLAUDE.md` to the current state and what is next; the
  milestone notes already hold the history.

## Not in this plan

- **StoryGraph slash dates (D5).** `historyDate` reads `03/04/2024` as 3 April. Whether that is
  right depends on what a real export writes. Change nothing until the owner shares one; then
  record its date shape (no titles) in the M4 notes.
- Case-insensitive path matching on case-sensitive file systems. Windows is the supported
  platform.

## Done means

- All four checks pass, and CI is green on Ubuntu and Windows.
- Every fix has a test that failed before it.
- Screenshots looked at for Stage 1.
- `docs/milestones/M6.md` has a short note per stage, with anything that needs checking on the
  owner's machine listed as such.
- `docs/owner-checklist.md` has any new owner check in plain steps.
- The final message says, first, anything the owner must do, then which defaults were used for
  D1 to D5.
