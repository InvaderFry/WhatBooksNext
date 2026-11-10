# Online ratings and automatic refreshes

Status: implementation plan; no application changes made. Researched 2026-11-10; revised the same
day against `main` after M6 (modes, taste, stats, export and full snapshots are all built), and
again to drop Google Books (see the end).

## Decisions the owner has made

- Keep Open Library, AniList, Hardcover, Metron and ComicVine.
- Choose the community rating by match strength, number of ratings and what the rating covers,
  instead of a fixed source order. Show the other sources' ratings and say why one was chosen.
- **Keep Hidden gems**, adjusted so it stays honest under the new choice (stage 1, below).
- **No Google Books.** Considered and dropped; reasons at the end of this plan.
- Refresh automatically while the app runs: every 7 days for books in progress or on the
  shortlist, every 30 days for the rest, in small batches.

Decisions made in this plan on the owner's behalf (say so if any should change):

- Unconfirmed ("provisional") matches still supply a rating, but only when nothing better exists,
  labelled as unconfirmed, and never for Hidden gems. Today they count fully; dropping them
  outright could empty modes that passed the first quality session.
- Each stage is its own pull request against `main`, in the order below.

This extends PLAN.md §12 and replaces its fixed rating-source order once stage 1 is merged.
Personal ratings, confirmed matches, rejections, reading history and owner corrections keep their
authority. A missing community rating stays unknown and neutral.

## What the code does today (on `main` after M6)

- `lib/ratings.ts`: `communityRating` picks Hardcover → AniList → Open Library regardless of
  votes or match strength. `ratingStats` builds each source's mean, median votes, "highly rated"
  line and "few votes" line (M5) from **one entry per item and source**, so an AniList series
  score attached to twelve owned volumes is counted twelve times.
- `identify/lookups.ts`: `chooseUsed` returns the owner-confirmed match, then each source's
  accepted **or provisional** best candidate. Ties and rejections are already left out.
- `lib/rankData.ts` drops series-scope ratings for items outside a series, then calls
  `communityRating`. Its `matchConfirmed` flag (owner override or strong ISBN) already exists.
- Everything that reads the chosen rating: the blend and its reasons/limits in
  `lib/recommend.ts`; **Waiting on your shelf**, **Hidden gems** and **Classics** in
  `lib/modes.ts`; sorting in `routes/reading.ts`; the item page (`OnlineCard.tsx`); and the
  CSV export (`lib/export.ts`).
- `source_cache` keeps raw answers with `fetched_at` and no expiry; it is not backed up.
  `item_matches` (normalised records, including ratings) **is** in backups, and M6's full
  snapshot copies the whole database except `secrets`. `lookup_state` records when each item
  and source was last looked up.
- The library is about 2,700 items (M1). A 30-day cycle over it is roughly 90–180 requests a
  day across all sources, well inside every source's limits; the budgets below are a safeguard,
  not the main constraint.

The match score is a heuristic, not a probability. Never describe 0.90 as a 90% chance of being
right, and never multiply it by a vote count.

## Stage 1 — choose the rating (pure, no network changes)

### Evidence

Extend what the selector receives per rating: source, source record id, scope, raw value and
scale, vote count (missing stays `null`, distinct from 0), this source's decision for the item
(`confirmed` by the owner, `accepted`, or `provisional`), whether an ISBN agreed strongly, the
record's link, and when that source last answered successfully.

### Selection (one pure function in `lib/ratings.ts`)

Eligible: a rating whose match is owner-confirmed, accepted or provisional; not rejected, not a
tie; a valid value and scale; and, for a series score, an item that belongs to that series.
Confirming one source's match does not confirm another source's record.

Take the first non-empty tier:

1. Confirmed/accepted, item scope, at least `RATING_SUPPORTED_VOTES` (20) ratings.
2. Confirmed/accepted, series scope, supported. Shown as "Whole series; this volume has few
   ratings" (or "…has no rating").
3. Confirmed/accepted, item scope, fewer or an unknown number of ratings ("Few ratings" /
   "Number of ratings unknown").
4. Confirmed/accepted, series scope, sparse.
5. Provisional, any scope that is allowed, labelled "Unconfirmed match" with a link to confirm.

Within a tier: owner-confirmed, then strong ISBN, then accepted; then more ratings, compared up
to `RATING_VOTES_CAP` (1,000) so huge popularity gives no further edge; then the higher match
score; then the old order as a last stable tie-break (Hardcover, AniList, Open Library, demo).
Nothing eligible means unknown, never zero.

Return the chosen rating, the other eligible ratings, the excluded ones with why, and a short
reason code (`more_ratings`, `only_rating`, `series_fallback`, `unconfirmed_only`, …). Item
details, recommendations, modes and export all use this one result.

### Source statistics

Build `ratingStats` from unique rating targets, `source:sourceId`, so one series score is counted
once. Keep Bayesian shrinkage and each source's own "highly rated" and "few votes" lines. Never
average different sites into one score and never add vote counts across sites or editions. Raw
displayed values stay as the source gave them. Personal ratings still replace the community
part of the blend.

### Hidden gems, Classics and Waiting on your shelf

- **Hidden gems**: the chosen rating is highly rated for its source, item scope (never series), from
  a confirmed or accepted match, with at least `HIDDEN_GEM_MIN_VOTES` (5) ratings and at or below
  its source's few-votes line, **and** every other confirmed or accepted rating with a known count
  is also at or below its own source's few-votes line ("few ratings everywhere we looked"). The new
  choice makes this more honest: a book with 8 Hardcover ratings but 3,000 on Open Library is no
  longer called hidden. An unconfirmed match never blocks a gem either: a wrong book's 3,000 ratings
  say nothing about this one. A popular whole-series score is chosen over a sparse volume score
  (tier 2), so that volume is not a gem: the series is well known. Keep the reason "Only N ratings
  on Source — few for your library" and add "and few elsewhere" when another source agrees.
- **Classics** and **Waiting on your shelf** keep using "highly rated" on the chosen rating. A
  provisional-only rating may still qualify but its card says "Unconfirmed match".
- Recommendation limits gain "rating is from an unconfirmed match" next to the existing "rating
  is for the whole series".
- Export: keep the existing column names and order; append `community_scope` and
  `community_match` (`confirmed`, `accepted`, `provisional`).
- Diagnostics: how many items' ratings now rest on each tier, especially tier 5, so the owner can
  confirm matches where it matters.

### Checks (invented fixtures)

- A securely matched Open Library book with 3,000 ratings beats the same book's Hardcover score
  with 3.
- A million ratings cannot rescue a tie, a rejected candidate or a wrong-volume match.
- A supported manga volume score beats a series score; a supported series score replaces a
  3-rating volume score with the fallback label.
- A provisional rating is used only when nothing confirmed or accepted exists, and never makes a
  Hidden gem.
- Twelve volumes sharing one AniList series score count once in that source's statistics.
- Hidden gems: still has a populated and an empty demo case (M5's done-when); a book that is
  sparse on one source but popular on another is left out.
- No eligible rating: unknown, neutral in the blend, fails "highly rated".
- Personal rating still overrides; existing scenario tests still pass.

### Before and after

Stage 1 changes ratings across the whole library, so measure it. Extend `npm run report:matches`
(or add a sibling script) with a title-free comparison of old and new choices: how many items
changed source, gained or lost a rating, moved tier, or entered or left Hidden gems, Classics and
Waiting on your shelf. Put the counts in the pull request. Do the owner's second quality session
(§17.2, still open from M6) **after** stage 1, so it judges the new behaviour.

No migration is needed for stage 1. Do not raise `MATCH_VERSION`: matching does not change.
Put the new constants in `config.ts` and PLAN.md §20, marked as assumptions until calibrated
against the owner's library (Diagnostics' tier counts help).

## Stage 2 — "Ratings by source" on the item page

- Cards keep one rating, with its source, count and scope, and a short label when it is sparse,
  a series fallback or unconfirmed.
- The item page gets an expandable **Ratings by source** list: raw score and scale, number of
  ratings (a rating count, not a review count), what it rates (book / volume / series), match
  status, link, when last looked up (stage 3 adds the time of the last real network answer), and
  which one is used with its reason
  ("More ratings for this book"). Unconfirmed ones are listed apart with the existing confirm
  action; they are never shown as verified.
- Phone-width, keyboard, light/dark and reduced motion; check with `npm run screenshots` and its
  accessibility sweep.
- Refresh-related labels ("Refresh due", "Refresh failed; showing the previous result") arrive
  with stage 3, not here.

## Stage 3 — automatic refresh

Built around the existing `LookupManager`, not as a second lookup engine.

- **When:** check after startup and periodically while running. Nothing runs in demo mode, after
  shutdown, when the setting is off, during a scan, or while a manual lookup runs (it defers).
  After a long time closed, catch up gradually.
- **What is due:** per item and source, from `lookup_state.looked_up_at`: 7 days for in-progress
  and shortlisted items (`REFRESH_ACTIVE_DAYS`), 30 for the rest (`REFRESH_OTHER_DAYS`). Add
  next-eligible time and failure count per item and source in a numbered migration, and keep the
  time of the last real network answer apart from local re-scoring, so re-reading an old cached
  answer never looks fresh. Add the new columns to backup (owner-relevant timings) or its
  commented exclusion list, and to `app.release.test.ts`.
- **How much:** batches of up to 25 source requests. New items and the owner's own actions
  first, then in-progress and shortlisted, then the oldest. Automatic work may use at most 20% of
  a source's daily allowance where it has one (Hardcover, Metron); count every real request,
  including secondary ones. Skip a source whose circuit breaker is open; never reset breakers
  from the scheduler. Back off with jitter on transient failures; a daily-quota answer pauses that
  source until the next day. Metron first and ComicVine only as fallback, as now. Share work with
  the existing 7-day published-series check so nothing is asked twice.
- **What a refresh may change:** it re-asks the source and re-scores. It may update the rating,
  count and other facts of the **same** matched record. It never replaces an owner-confirmed or
  auto-accepted match with a different record: if a different candidate now wins, keep the
  current match and add a "Check this match" entry to Needs review. A record that now has no
  rating becomes unrated (it does not keep the old one). An empty, failed or ambiguous answer
  keeps the previous result and records the failure. Re-check that the item still exists and is
  unchanged before saving (merges, splits and edits during a request), as manual lookups already
  do. Call `syncSeries` after a batch that changed series facts, as manual lookups do. Owner
  corrections (`user_item`) are never touched.
- **Controls:** Settings: automatic refresh on/off (on by default; off in demo), the two
  intervals shown (fixed values from `config.ts`, not editable), pause/resume and
  "Refresh due books now". Diagnostics: per source, how many are due, last success, requests used
  by automatic work, pauses and failures. Item page: "Refresh due" and "Refresh failed; showing
  the previous result" labels; a refresh never blanks a page.
- **Checks (fake clock, no network):** due selection by status; priority order; 429, quota and
  5xx handling; budget enforcement including secondary requests; cancellation and restart;
  demo/off/scan/manual deferral; a removed rating becomes unrated; a failure keeps the old
  result; confirmed, accepted and rejected decisions survive a refresh and a restore.

## Documentation for every stage

Update PLAN.md (§12 sources and ratings, §20 values, §21 owner actions), README source coverage,
Diagnostics text and the milestone notes. List Windows checks as open items; Linux fakes don't
prove them.

Each pull request must pass `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build` and `npm run report:matches` (0 wrong high-confidence
matches), with `npm run screenshots` inspected for UI changes.

## Owner actions

- **After stage 1 or 2:** glance at Diagnostics' count of ratings that rest on unconfirmed matches
  and confirm any that matter. No new accounts or keys are needed for this plan.

## Google Books: considered and dropped (2026-11-10)

Do not re-propose without new facts. The owner hoped for reviews, corrected titles and more
metadata; Google Books would not have delivered enough of that to justify its rules:

- **Storage.** Google APIs Terms §5(e) forbid "permanent copies" and caching "longer than
  permitted by the cache header", and forbid derivative works; the Books terms add no allowance.
  There is no fixed period (such as 12 months) the app could keep data for, and a manual purge
  does not make a longer period allowed. Rankings need stored data, so Google could at best be
  shown live on a book's page.
- **Reviews.** The API has no public review text, only an optional average rating and count.
- **Access.** A key is needed in practice: keyless requests from the development container were
  refused (HTTP 429). That means a Google Cloud project and key for a personal, read-only app.
- **Overlap.** Titles, authors, ISBNs, subjects and pages already come from Open Library and
  Hardcover, plus the files themselves and Calibre.

Sources read: [Google APIs Terms](https://developers.google.com/terms),
[Google Books API Terms](https://developers.google.com/books/terms),
[Using the Books API](https://developers.google.com/books/docs/v1/using),
[Volume fields](https://developers.google.com/books/docs/v1/reference/volumes).
