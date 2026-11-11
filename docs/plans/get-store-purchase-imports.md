# Import store purchases: official exports first, then a browser extension

Status: planned. Nothing is built yet, and no store has been checked on a signed-in account.
Written 2026-11-11. This revises a first draft from 2026-11-10 ("console scripts, then one
extension") after a review. The review kept the draft's rules and its order of proving extraction
before packaging it. It added: checking each store's official export before scraping anything,
account safety limits, the owner's steps written for a non-programmer, building one store end to
end before the others, and a plan for when a store changes its website.

This plan extends PLAN.md §14. It replaces §14's limit that store libraries are entered only by
hand, by search or from a prepared spreadsheet. Every other project decision still applies,
including the hard rules in `CLAUDE.md`. Read those first.

## Goal

Bring the books and comics the owner already owns in online stores into whatBooksNext as store
items, so the ranking can recommend them. Import **metadata only**: never ebook files, PDFs or
comic pages.

## Decisions the owner has made

- **Stores in scope:** Amazon Kindle, Google Play Books, Kobo and GlobalComix.
- **Apple Books is out of scope.** It has no web library to read, and it runs only in Apple's
  apps, which a Windows PC can't reach. The owner buys there, so say that plainly in the UI:
  Apple Books titles still go in by search, manual entry or the store CSV
  (`web/src/pages/StoreBooks.tsx`). Don't drop the `apple_books` store name.
- **Sign-in stays with the store.** The owner signs in on the store's own website in their own
  browser. whatBooksNext never asks for, sees or stores a store password, cookie or token.
- **Only on request.** An import starts only when the owner asks for it. No schedule and no
  background sync.
- **What counts as owned:** purchases and free titles claimed for good. Exclude samples,
  wishlists, loans, library borrows, Kindle Unlimited / Kobo Plus / GlobalComix subscription
  access, personal documents and the owner's own uploads. When ownership is uncertain, the record
  goes to review. Never guess a purchase.
- **Reading status** comes across only where the store shows it reliably. It only fills what is
  empty. The owner's own data in the app always wins (the same rule as `ownerChanges` in
  `server/src/lib/store.ts`).
- **Ownership doesn't make a book Ready to read.** The owner can tick
  "I can read these in this store now" for many books at once. That sets
  `locations.confirmed_readable`. Store items stay eligible for recommendations under the existing
  rules.
- **Hand over a file.** The collector downloads a JSON file and the owner chooses it in the app.
  The collector never talks to the app, so `server/src/security.ts` stays as it is, and collecting
  works while the app is closed. Sending data straight to the app is a later idea, not part of this
  plan.
- **Google Books stays dropped as a metadata and ratings source.** Importing the owner's Google
  purchases doesn't bring it back (see `docs/plans/online-ratings-and-refreshes.md`).
- **Every store copy gets a link to read it there** (decided 2026-11-11; this replaces PLAN.md
  §14's "a label, not a link"). Most store books and comics can't be downloaded, so the store is
  where they're read. A book with a store location shows **Read in Kindle ↗** (and so on), which
  opens the book in that store's web reader or on its store page. This applies to books added by
  hand or by CSV too, not only imported ones (see "Store links").

## Decisions added by the review

1. **Check each store's official export before writing a scraper (Stage 0).** An official file
   or API rarely breaks, needs no scraping and has no account risk. A scraper is built only where
   the official route is missing, incomplete or too hard for the owner. Even where a scraper is
   still needed, the official export can confirm that a scan found everything.
2. **Build one store end to end first (Stage 1):** collector, JSON file, preview and import, and
   the extension. Only then add the other stores. That proves the whole path once, and later stores
   reuse it.
3. **Only add a store if it's worth it.** PLAN.md §3 says the owner has "a handful of store-locked
   titles". If the owner has fewer than about 10 books in a store, the store CSV or manual entry is
   enough. Skip that store's collector and record why. The other rules (libraries of 100+ books,
   multi-page scans) still apply to any collector that is built, because other people will use the
   app (PLAN.md §2).
4. **Protect the owner's store accounts** (see "Account safety"). They come before speed and
   before being complete.
5. **Every step the owner takes is written out**, with no command line ("Owner actions").
6. **A broken collector must say it's broken.** A store changing its website must never look like
   an empty or smaller library ("When a store changes its website").

## Fit with the existing code

| Exists today                                                                         | Where                                                                      | How this plan uses it                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Store names (`kindle`, `kobo`, `globalcomix`, `apple_books`, `google_play`, `other`) | `server/src/lib/store.ts` `STORES`, `001_init.sql` `locations.store` CHECK | Reused unchanged; no new store names.                                                   |
| Creating store items and locations                                                   | `createStoreItem`, `addLocation` in `lib/store.ts`                         | Reused for the JSON import.                                                             |
| Matching by ISBN and title + author                                                  | `isbnIndex`, `titleIndex`, `itemsWithTitle`                                | Reused after the store-record-ID match.                                                 |
| Owner-data-wins merge                                                                | `ownerChanges`, `applyUserPatch`                                           | Shared by CSV and JSON. Factor it out without changing how CSV behaves.                 |
| Repeat-import keys                                                                   | `import_keys` (`008_imports.sql`), `rowKey`                                | JSON uses its own `source` value per store (below). The CSV key stays exactly as it is. |
| CSV preview/import UI and routes                                                     | `web/src/pages/StoreBooks.tsx`, `server/src/routes/store.ts`               | The JSON import gets its own preview/import endpoints and a section on the same page.   |
| Backup and restore coverage                                                          | `server/src/lib/backup.ts`, `server/src/app.release.test.ts`               | Any new table gets added to both (a test enforces it).                                  |

The current CSV can't hold a store's own record ID, how the book was acquired, or whether a scan
was complete. Its repeat key is the ISBN, otherwise title + author + store. So add a **versioned
JSON import** for the collectors. Keep the CSV unchanged, and don't quietly change how a legacy
import behaves.

## Stage 0: official exports, and the owner's numbers

For each store, the agent researches the official routes and records what it finds here, with
dates and links. Then the owner tries the promising ones (owner action A1). Things to check (none
of this is verified yet):

| Store             | Official routes to check                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amazon Kindle     | "Request your data" (the account privacy page): does it include a file of Kindle purchases and claimed free books, with ASINs, purchase type and dates? How long does it take to arrive, and is it different by country? |
| Google Play Books | Google Takeout's Play Books data. The Google Books API "My Library" bookshelves, which needs an OAuth client: is that too much setup for the owner? Does a shelf list only purchases, without uploads or samples?        |
| Kobo              | Kobo's account data / privacy request. Any library export on kobo.com.                                                                                                                                                   |
| GlobalComix       | Any account export or public API for purchases and permanent unlocks.                                                                                                                                                    |

For each route, record: what it contains (fields only, never titles), whether it tells purchases
apart from samples, loans and subscriptions, how long it takes, how many steps it needs, and
whether the format looks stable.

**Decision per store**, recorded in this file:

- **Official route:** write a parser for that file in `lib/` (pure, tested with invented
  fixtures). It produces the same records as the JSON format below, imported with the same preview.
  No collector is needed.
- **Collector:** the official route is missing, lacks ownership information, or is too hard. Build
  a collector (Stages 1–2), and if the official route exists, use its counts as a completeness
  check.
- **Skip:** the owner has too few books in this store (decision 3). Point to CSV or manual entry.

**Done when:** each of the four stores has a recorded decision, and the owner has said roughly how
many books they own in each (owner action A1). Stage 1 starts with the store that has the most
books and needs a collector. If the owner can't say, start with Kindle.

## Store links

This part needs no collector, so build it **first**, right after Stage 0. It helps the store
books already in the app straight away.

- **Where the link is kept:** migration `014_store_links.sql` (the next number; never edit
  `001_init.sql`) adds `url`, `url_kind` (`read` or `page`) and `url_by_owner` (0/1) to
  `locations`. `locations` is already in the backup. Add the new columns to the restore
  regression row in `app.release.test.ts`. The `store_purchases` migration in Stage 1b then
  takes the next number.
- **Only safe links:** `https` only, and the host must be on that store's list in one place in
  `lib/store.ts`. For example, Amazon's country sites and `read.amazon.*` for Kindle,
  `play.google.com` for Google Play Books, `kobo.com` for Kobo, and `globalcomix.com`. Check the
  exact hosts and paths per store and record them here. A link that fails is refused with a plain
  message. A link to some other site is never saved. `other` and `apple_books` take no automatic
  link. The owner can save an `https` link of their own for `other`, shown with its host so they
  can see where it goes. Apple Books gets none, since it isn't on the web.
- **How links are made:**
  - **Imported:** from the record's `readUrl` / `pageUrl`. Prefer the reader link.
  - **From the store's ID:** a link pattern per store (for example Kindle's web reader by ASIN).
    Use it only once it has been checked on the owner's signed-in account, and record the check
    here. An unchecked pattern isn't used. A link is never built from a title search.
  - **Typed or pasted by the owner:** in manual entry and on the book page's "In a store app"
    list (`web/src/pages/StoreBooks.tsx`), as **Add link / Change link / Remove link**.
  - **CSV:** a new optional `url` column. Files without it still import exactly as before.
- **Owner corrections win:** a link the owner typed, changed or removed sets `url_by_owner`.
  Imports then never replace it, and a removed link stays removed. An import fills a link only
  where none exists. A repeat import (outcome "already") can still add a missing link to an
  existing location. That's how books entered earlier by CSV or by hand get their links.
- **Where it shows:**
  - **Read in <store> ↗** on the book page, the What next cards, the Shortlist and Library rows,
    next to the existing "can I read it here" tick.
  - For a book that is only in a store, it's the main action, where **Open** is for a file.
  - For a book with both a file and a store copy, **Open** stays first while the file is present.
    When the drive is disconnected or the file is missing, the store link comes first.
- **How it opens:** a normal link with `target="_blank"` and `rel="noopener noreferrer"`, in the
  owner's own browser, where they are signed in to the store. The server never fetches it. The app
  only checks the link's form, never whether the page works (that would be a request to the store).
- **Exports:** add the link as a column in the CSV export (`lib/export.ts`). It's the owner's own
  data. It contains store IDs but no titles. Like all owner data, it never goes in the repo.
- **Tests:** link rules (allowed and refused hosts, `http`, `javascript:`, other sites, typed
  versus imported, owner removals kept), the CSV `url` column, and links showing in each place.
  Use invented IDs only. Check with `npm run screenshots`, including the demo's store books (add
  invented links to the demo, never real IDs that might point to a real book).

**Done when:** every store book can carry a working link. The owner has clicked one for each store
they use and it opened the right book (owner action A1b). Owner edits survive a repeat import.

## Account safety

Apply these to every collector and write them into the owner's instructions:

- **Read-only.** Only load library pages and make the same read-only library requests the store's
  own page makes. Never click or send anything that buys, returns, archives, deletes, lends,
  downloads a book or changes reading state. Before using a request, check what it does and record
  it.
- **Slow.** At most 1 page load or request every 2 seconds, a 30-second pause after every 50, and
  at most 300 pages or requests per scan. Keep these numbers in one constants file in the collector
  core, each with its reason, and add them to PLAN.md §20 as assumptions.
- **Stop at the first warning.** Stop and export what was collected so far, with the reason, on a
  CAPTCHA, a sign-in or verification page, HTTP 401/403/429, or an unexpected redirect. Never retry
  in a loop. Never try to get around a check.
- **Same browser, same session.** No headless browser, no copied cookies, no reaching the store
  from the app server.
- **Tell the owner the risk** once, before the first scan: automated reading of a store page may
  break that store's terms of use, and a store could challenge or restrict an account that does
  unusual things. These limits keep the activity close to the owner scrolling their own library.
  Let the owner decline and use CSV or manual entry instead.

## Stage 1: one store end to end

### 1a. Collector core and the first store's adapter

Code lives in `tools/store-collector/`:

- `core/`: what every store needs. Checking the page and host, the scan loop (pagination,
  "load more" buttons, infinite scroll), deduplication by store record ID, handling lists that
  drop items scrolled off screen, spotting repeated cursors and stalled loading, the safety
  limits, cancellation, and building the JSON file. Keep **every record seen**, not only what is
  on screen at the end.
- `adapters/<store>.ts`: one per store. Which pages it recognises, how to read a record, how it
  decides ownership, how to move to the next page, and a **layout fingerprint** (see "When a store
  changes its website").
- Erasable TypeScript, as on the server. Bundle with the Vite/esbuild already in the `web`
  workspace (`npm run build:collector`). **Add no new dependency that needs an install script**
  (`.npmrc` sets `ignore-scripts=true`).
- The build makes two things from the same code: a readable **console script** per store, used
  only to prove extraction, and the extension (1c). The two must not be separate implementations.

The collector must:

- Check the host and page. If they're wrong, say which page to open and how to get there.
- Use the signed-in session. If a sign-in or verification step appears, stop and ask the owner to
  finish it, then start the scan again. Never type into sign-in forms.
- Read the library page first. Use the store's read-only library requests only where the page
  alone isn't enough, after checking what they do.
- Stop cleanly on cancel, sign-out, a blocked request, a layout mismatch or a safety limit. Export
  what it has, marked `partial` with a reason. An interrupted scan is never reported as complete.
- Produce two outputs:
  - the **JSON file** (with titles: the owner's own file, which never goes in the repo);
  - a **title-free report** the owner can paste into chat: browser and version, store region,
    date, adapter version, pages visited, records found, counts excluded by reason, uncertain
    count, completeness and reason, fingerprint result, and any errors. Never titles, IDs,
    account names or emails.

**Tests:** pure parsing and ownership rules run in vitest against **invented** page snippets and
request bodies in `fixtures/stores/<store>/`, copying the real structure. Test multi-page,
repeated-cursor, stalled, cancelled, sign-out and fingerprint-mismatch cases. Fixtures prove the
logic, not that it works on the live store.

### 1b. JSON format, preview and import

**File envelope** (`format: "whatBooksNext-store-purchases"`, `formatVersion: 1`):

| Field                     | Rule                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`, `formatVersion` | Required. The app refuses unknown formats and newer major versions, with a clear message.                                                                                                                                                        |
| `service`                 | Required. One of `kindle`, `google_play`, `kobo`, `globalcomix` (the `STORES` names).                                                                                                                                                            |
| `adapterVersion`          | Required. Shown in the preview and stored with the import.                                                                                                                                                                                       |
| `source`                  | `collector` or `official_export`, plus the name of the official file when there is one.                                                                                                                                                          |
| `collectedAt`             | Required. ISO 8601 time.                                                                                                                                                                                                                         |
| `region`                  | Optional. The store's country site (for example `amazon.co.uk`), never the account's address.                                                                                                                                                    |
| `accountScope`            | Optional opaque string: SHA-256 of the store's own account identifier plus a random salt kept on the collector's side. Never an email, name, cookie or token. Without it, the app asks "Is this your only account at this store?" (default yes). |
| `completion`              | Required: `complete`, `partial` or `failed`, plus a `reason` (`finished`, `cancelled`, `signed_out`, `blocked`, `layout_changed`, `limit_reached`, `error`) and its text.                                                                        |
| `counts`                  | Required: seen, included, excluded by reason, uncertain. The app checks them against the records.                                                                                                                                                |
| `records`                 | Required array.                                                                                                                                                                                                                                  |

**Each record:**

| Field                   | Rule                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storeRecordId`         | Required. The store's own stable ID: an ASIN, Google volume ID, Kobo product ID, or GlobalComix release/collection ID. Unique only within `service` (and `accountScope`), never across stores.                                                                                    |
| `idKind`                | Required. What the ID is (`asin`, `volume`, `product`, `release`, `collection`, …).                                                                                                                                                                                               |
| `title`                 | Required, as the store shows it.                                                                                                                                                                                                                                                  |
| `creators`              | Optional list of `{ name, role }`. Role is `author`, `writer`, `artist` or `unknown`; never guessed.                                                                                                                                                                              |
| `kind`                  | Optional: `book`, `comic`, `manga` or `unknown`, only when the store says so.                                                                                                                                                                                                     |
| `unit`                  | Required for GlobalComix, optional elsewhere: `issue`, `volume`, `collection` or `book`. It records what was actually bought; the issues inside a collection are never added as owned.                                                                                            |
| `series`, `seriesIndex` | Optional, only as the store shows them.                                                                                                                                                                                                                                           |
| `isbn`                  | Optional, only when the store shows one. Normalised with `normIsbn`.                                                                                                                                                                                                              |
| `acquisition`           | Required: `purchase`, `free_claim`, or `uncertain`, plus the evidence (the label or field it came from). Excluded types aren't records; they're only counted.                                                                                                                     |
| `acquiredAt`            | Optional, with a precision (`day`, `month`, `year`). Otherwise left out, never invented.                                                                                                                                                                                          |
| `readingStatus`         | Optional: `not_started`, `in_progress` or `finished`, only where the store shows it reliably. `progressPercent` is optional.                                                                                                                                                      |
| `readUrl`, `pageUrl`    | Optional. `readUrl` opens the book in the store's web reader; `pageUrl` is its page in the store or library. Only as found on the page, or built from `storeRecordId` by that adapter's checked pattern (see "Store links"). Checked on import against the store's allowed hosts. |

Check every field on the server. A record with bad fields becomes a problem line, and the rest of
the file still imports.

**Repeat imports:** `import_keys.source = 'store_json:<service>'` and
`row_key = '<accountScope or "default">:<idKind>:<storeRecordId>'`. The `store_csv` keys stay as
they are.

**New table** (migration `015_store_purchases.sql`, after `014_store_links.sql`; never edit `001_init.sql`):
`store_purchases` holds `item_id`, `service`, `account_scope`, `store_record_id`, `id_kind`,
`unit`, `acquisition`, `acquired_at`, its precision, `first_seen_at`, `last_seen_at`,
`last_complete_scan_at`, `adapter_version`. Add it to the backup and to the restore regression in
`app.release.test.ts`. Also keep a `store_import_runs` log (time, service, adapter version,
completion, counts; no titles). Exclude it from backups with a commented reason, like `scan_runs`.

**Matching, in order:**

1. The same `store_json:<service>` key → **already imported**. Update `last_seen_at`; create
   nothing.
2. A single library item with the same ISBN → **attach** a location there.
3. A single item with the same title + creator (`itemsWithTitle`) → **possible match**, attached
   only if the owner ticks it. This also finds books entered earlier by CSV or by hand, so they
   aren't duplicated.
4. Otherwise → **new** store item, unverified until a lookup finds it. Never invent an identity.

`acquisition: uncertain` records are shown separately and import only if the owner ticks them.

**Preview** (nothing changes until **Import selected books**): totals, completeness (a `partial`
or `failed` file is labelled clearly but can still be imported), new books, already imported,
attaches, possible matches, uncertain ownership, excluded counts by reason, problems, and the
reading status that would fill empty fields versus where the owner's own data is kept. After
import, show the counts added, attached, already imported and skipped.

**Books missing from a later scan:** a book not seen in a **complete** scan of the same account
isn't deleted. It goes to Needs review as "Not seen in your latest Kindle scan: returned, refunded
or removed?" with Keep / Remove store location. A partial scan never raises this.

UI: a new section on the existing store books page, **Import store purchases** (settings link
there too). Pick a store and it shows that store's steps, then a file picker. Check it with
`npm run screenshots` (light and dark, desktop and phone) using an invented demo file. Write route
tests against in-memory SQLite for each outcome, re-importing the same file, partial files, and the
owner's data winning.

### 1c. Package as a browser extension

- One Manifest V3 extension for **Microsoft Edge and Google Chrome** (Edge is the Windows
  default). Firefox comes later; it won't keep an unsigned extension installed.
- Ask only for the host permissions of the store library pages that have a built adapter, listed
  per country site (Amazon has a different site per country). No `<all_urls>`, no access to
  `localhost`, no remote code, no analytics.
- The popup shows the store it found, books collected, whether more pages are loading, and a
  Cancel button. Then it shows totals, exclusions, uncertain records and completeness, offers
  **Download file** and **Copy report (no titles)**, and shows the one-time account risk notice.
- Ship it as a zip in GitHub Releases, with the version in the name. Installing it means
  "Load unpacked" in developer mode, with screenshots of each step in `INSTALL.md`. Publishing on
  the Chrome/Edge stores, which ends the developer-mode warning, is a later option. Record its cost
  and review process when it comes up.

**Done when (Stage 1):** the first store works end to end on the owner's signed-in account. That
means owner actions A2–A4 have been done, the title-free reports match the store's own count (or
the official export's count), and tests, typecheck, lint and format pass on Ubuntu and Windows CI.
If the owner's library fits on one page, multi-page scanning is proven only on fixtures. Record
that as a remaining real-account check, not as supported.

## Stage 2: the remaining stores

For each store whose Stage 0 decision is "collector", in order of the owner's book counts: add an
adapter, then prove it with the console script and the owner's report, then add it to the
extension. Release a new extension version with each one. For every store, also check its reader and
book-page link pattern ("Store links"). Things to check on a signed-in account:

| Store             | Check                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Play Books | Purchases and claimed free books, told apart from uploads, samples and other shelves; stable volume IDs; how the library pages; reading status.                                                                                                                |
| Amazon Kindle     | Purchases and permanent free books, told apart from samples, personal documents, loans and Kindle Unlimited; ASINs; country-specific library pages; how it pages.                                                                                              |
| Kobo              | Purchases, told apart from previews and Kobo Plus; product IDs; archive and library filters; how it pages; reading status.                                                                                                                                     |
| GlobalComix       | Purchases and permanent unlocks, told apart from subscription, follows and reading lists; whether the unit is an issue, volume or collection; release/collection IDs; how it pages; reading status. A permanent unlock counts even without a downloadable PDF. |

**A collector that hasn't been checked is never shown as working.** In the extension and the app,
each store is **Checked on <date>**, **Not checked yet**, or **Not supported** (with the reason).

## When a store changes its website

- Each adapter has a **layout fingerprint**: the few things it relies on (a container, a record
  field, the paging control or request). Before a scan, and again on every page, check them. If
  one is missing, stop with `layout_changed`. Never report an empty or smaller library as
  complete.
- If a complete scan finds far fewer books than the last complete scan of the same account (more
  than 20% fewer, as a PLAN.md §20 assumption), the app shows a warning in the preview, and the
  "not seen" review isn't raised until the owner confirms.
- Diagnostics shows the last import per store: time, adapter version, completion and counts (no
  titles).
- **Fixing it:** the owner pastes the title-free report into chat. An agent updates the adapter and
  its invented fixtures, raises the adapter version, and publishes a new extension zip. The owner
  updates the extension (owner action A5). A broken store never stops the other stores working.

## Owner actions

Tell the owner plainly, at the start of the message, when each is due (as PLAN.md §21 asks). Add
these rows to PLAN.md §21 when the stage starts.

| ID  | When                  | What the owner does (no command line)                                                                                                                                                                                                                                                                      | Time                                 |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A1  | Stage 0               | Say roughly how many books you own in Kindle, Google Play Books, Kobo and GlobalComix. For each store where the agent found an official export, follow its steps to request it. When it arrives, open it and tell the agent only which columns it has and how many rows (no titles).                       | 10 min, plus waiting days for Amazon |
| A1b | Store links           | On a few store books (one per store you use), open the book page, add the link (copy it from the store's reader or book page in your browser), and click **Read in … ↗**. Say whether it opened the right book.                                                                                            | 5 min                                |
| A2  | Stage 1a              | Sign in to the first store in Edge or Chrome, open its library page, and paste the provided script into the browser's developer console (the steps include Chrome's "allow pasting" prompt). Wait for it to finish, then paste the **title-free report** into chat. Keep the downloaded JSON file private. | 10–15 min                            |
| A3  | Stage 1b              | In whatBooksNext: store books → Import store purchases → choose the JSON file. Check that the preview looks right, then import. Say whether anything was wrong (no titles needed).                                                                                                                         | 10 min                               |
| A4  | Stage 1c              | Install the extension by following `INSTALL.md` (download the zip, unzip, open the browser's extensions page, turn on Developer mode, Load unpacked). Run **Scan this library** on the same store, import the file, and check that nothing is duplicated.                                                  | 15 min                               |
| A5  | Each new store or fix | Install the new extension version the same way (or click Reload on the extensions page after replacing the folder), run a scan, and paste the report.                                                                                                                                                      | 10 min per store                     |

Never share in chat: the JSON file, book titles, account names, emails, or anything from the
store's sign-in.

## Privacy and repo rules

- The repo is public. JSON files, reports with titles, official exports and anything derived from
  them stay off it. Fixtures are invented and copy real structures only. Milestone notes record
  only title-free counts and patterns.
- The app reads the chosen file during preview and import, and doesn't keep a copy. What it keeps
  is the imported items, `store_purchases` and the run log.
- Store passwords, cookies and tokens never pass through the collector's output or the app.

## Done for the whole plan

- Every store in scope has a recorded decision: official export, checked collector, or skipped
  with a reason. Apple Books' exclusion is explained in the UI.
- Each supported store is checked on the owner's signed-in account, or has a specific documented
  blocker. Remaining real-account checks are listed in the milestone notes as "needs checking on
  the owner's machine".
- Importing again adds new purchases without duplicates and never overwrites the owner's changes.
- Every store copy (imported, typed in or from CSV) can carry a checked link, and **Read in <store> ↗**
  opens it. Owner-typed and owner-removed links survive imports.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build` pass.
  `npm run screenshots` has been looked at. The restore regression covers `store_purchases`.
