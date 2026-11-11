# Online ratings, best details and automatic refreshes

Status: All four stages implemented (stage 4 on 2026-11-11; notes in `docs/milestones/M6.md`). Researched 2026-11-10 and revised the
same day: against `main` after M6, to drop Google Books (see the end), and after two independent
reviews whose corrections are folded in.

## Decisions the owner has made

- Keep Open Library, AniList, Hardcover, Metron and ComicVine. **No Google Books** (reasons at the
  end).
- **Every source's rating is kept and shown on the book page.** The one used is the rating about
  this book (not the whole series) with **the most ratings among trusted matches**. A trusted
  match is one the owner confirmed or the app accepted. The owner's confirmation and ISBN
  agreement only break ties; there is no cap on the comparison. Review text is not needed.
- **Keep Hidden gems**, adjusted so it stays honest under the new choice (stage 1).
- **Choose each detail from the best trusted source**, not one whole source per book:
  - Title and authors: the owner's own edits, then **Calibre** (the owner curated it), then the
    file's own metadata, then a trusted online match, then the filename guess.
  - First publication year: the **earliest** year among trusted matches (today's rule, minus
    unconfirmed matches). A single comic issue uses its own cover year, never its series' start.
  - Description: Hardcover's when it has a useful one, otherwise the longest; formatting such as
    Calibre's HTML is stripped first.
- **Refresh by how likely something has changed**: 7 days for books in progress or shortlisted,
  30 days where a source that rates this kind of book has no match, no rating or few ratings, 90
  days otherwise.
- **A background refresh never switches a match the app accepted on its own**; it asks the owner
  through Needs review. Two explicit buttons start fresh: the existing **Look up again** on a book
  page, enhanced, and a new **Look up all books again** in Settings (stage 4).
- The second quality session (§17.2, open since M6) moves to after stage 3, so it judges the new
  ratings and details.
- Unconfirmed ("provisional") matches still supply a rating, but only when nothing trusted
  exists, labelled as unconfirmed, and never for Hidden gems. The quality session checks how often
  that happens.
- One pull request per stage, in order: ratings, details, the book page (built once for both),
  then refresh.

Personal ratings, confirmed matches, rejections, reading history and owner corrections keep their
authority throughout. A missing community rating stays unknown and neutral.

## What the code does today (on `main` after M6)

- `lib/ratings.ts`: `communityRating` picks Hardcover → AniList → Open Library regardless of
  votes or match strength. `ratingStats` builds each source's mean, median votes, "highly rated"
  line and "few votes" line (M5) from **one entry per item and source**, so an AniList series
  score attached to twelve owned volumes is counted twelve times.
- `identify/lookups.ts`: `chooseUsed` returns the owner-confirmed match, then each source's
  accepted **or provisional** best candidate; ties and rejections are left out. Each lookup
  deletes a source's stored candidates for the item and keeps only the owner-confirmed one
  (`storeCandidates`); the app's own "accepted" choice is recomputed every time (`decisionsFor`)
  and nothing remembers it.
- `lib/rankData.ts` drops series-scope ratings for items in no series, then calls
  `communityRating`. Its `matchConfirmed` flag is per item (owner override, or any used match
  with strong ISBN evidence, Calibre included).
- Readers of the chosen rating: the blend and its reasons/limits (`lib/recommend.ts`); **Waiting
  on your shelf**, **Hidden gems** and **Classics** (`lib/modes.ts`); the **triage queue
  order** (rated books first, highest first, in the triage route of `routes/reading.ts`); the item
  page (`OnlineCard.tsx`); the CSV export (`lib/export.ts`). It picks up the new choice with no
  change of its own.
- **Not a reader, and unchanged:** the Library page's "Your rating" sort (`lib/library.ts`) uses
  only the owner's personal rating. Stage 1 leaves it as it is. (Added after stage 2, at the
  owner's request: a separate **Online rating** sort and a rating on each Library row, using the
  chosen rating's adjusted score, unrated books last.)
- Details: the title is the owner's, else the file's embedded title, else an accepted match's
  title (only when the file's title came from its filename), else the filename guess
  (`lib/library.ts`). Subjects are pooled from every used match (provisional included) and the
  file, and feed taste, topics and moods (`rankData.ts`); the kind guess also reads used matches.
  The first publication year is the **earliest** `firstPublishYear` of all used matches,
  provisional included (`refreshDerivedFacts`); a comic issue's is its cover or store year. Pages
  and the description come from the first used match that has them, in no deliberate order, so
  Calibre's comments (often HTML) can win today.
- Calibre imports are stored as matches with score 1 and, with an ISBN, strong ISBN evidence.
- Metron and ComicVine return no creators (`authors: []`) and no ratings.
- `user_item` has a title override but no override for creators, year, pages or description.
- `source_cache` keeps raw answers with `fetched_at`, no expiry, not backed up. `item_matches`
  and `lookup_state` are backed up as whole tables; M6's full snapshot copies the database except
  `secrets`. `lookup_state.looked_up_at` is rewritten by every lookup, including re-scoring from
  the cache after a `MATCH_VERSION` change, so it is not "when the source last answered".
- Each item page has **Look up again**, which re-asks its sources, ignoring cached answers. The
  server can do the same for every item (`POST /api/lookups` with `refresh`), but no button
  offers it.

The match score is a heuristic, not a probability. Never describe 0.90 as a 90% chance of being
right, and never multiply it by a vote count.

## Stage 1 — choose the rating (pure, no network changes)

### Evidence

Per rating: source, source record id, scope, raw value and scale, vote count (missing stays
`null`, distinct from 0), that source's decision for the item (`confirmed` by the owner,
`accepted`, or `provisional`), that match's **own** ISBN evidence (not the item-level
`matchConfirmed`), and the record's link.

### Selection (one pure function in `lib/ratings.ts`)

Every source's rating is already kept in `item_matches`; this stage changes only which one is
used. Nothing is deleted.

Eligible: a confirmed, accepted or provisional match (never rejected, never a tie) with a valid
value and scale. A series score needs the item to be in a series, as today (nothing links a
source's series id to a `series` row, so a stricter check isn't possible yet). Confirming one
source's match does not confirm another's.

Take the first non-empty tier:

1. Trusted (confirmed or accepted), item scope, at least `RATING_SUPPORTED_VOTES` (20) ratings.
2. Trusted, series scope, supported: "Whole series; this volume has few ratings" (or "…no
   rating").
3. Trusted, item scope, fewer or an unknown number of ratings ("Few ratings" / "Number of ratings
   unknown").
4. Trusted, series scope, sparse.
5. Provisional, any allowed scope, labelled "Unconfirmed match" with a link to confirm.

Within a tier: **most ratings** (an unknown count sorts below any known one); then confirmed,
strong ISBN, accepted; then the higher match score; then Hardcover, AniList, Open Library, demo
as a last stable tie-break. Nothing eligible means unknown, never zero.

So a trusted Open Library record with 5,000 ratings beats a confirmed Hardcover record with 25,
and 50,000 beats 1,000. Popularity _between different books_ is still tempered by each source's
Bayesian shrinkage, which this does not change.

Return the chosen rating, the other eligible ratings, the excluded ones with why, and a reason
code (`more_ratings`, `only_rating`, `series_fallback`, `unconfirmed_only`, …). Item details,
recommendations, modes and export all use this one result.

### Source statistics

Build `ratingStats` from the eligible ratings (provisional included, as today), counting each
rating target `source:sourceId` once, so one series score is counted once. Keep Bayesian
shrinkage and each source's own "highly rated" and "few votes" lines. Never average different
sites into one score and never add vote counts across sites or editions. Raw values are shown as
the source gave them. A personal rating still replaces the community part of the blend.

### Hidden gems, Classics and Waiting on your shelf

- **Hidden gems**: the chosen rating is highly rated for its source, item scope, from a trusted
  match, with at least `HIDDEN_GEM_MIN_VOTES` (5) ratings and at or below its source's few-votes
  line, **and** every other trusted rating with a known count is also at or below its own source's
  line ("few ratings everywhere we looked"). A book with 8 Hardcover ratings but 3,000 on Open
  Library is no longer called hidden. An unconfirmed match never blocks a gem (a wrong book's
  ratings say nothing about this one). A volume whose chosen rating is a popular series score is
  not a gem. Keep the reason "Only N ratings on Source — few for your library" and add "and few
  elsewhere" when another source agrees.
- **Classics** and **Waiting on your shelf** use "highly rated" on the chosen rating. A
  provisional-only rating may qualify, with "Unconfirmed match" on the card.
- Recommendation limits gain "rating is from an unconfirmed match" beside "rating is for the
  whole series".
- Export: existing columns unchanged; append `community_scope` and `community_match`.
- Diagnostics: how many items rest on each tier, and how many of What next's picks rest on tier 5,
  for the quality session.

### Checks (invented fixtures)

- A trusted Open Library book with 3,000 ratings beats the same book's Hardcover score with 3,
  and a trusted 5,000 beats a confirmed 25.
- A million ratings cannot rescue a tie, a rejected candidate or a wrong-volume match.
- A supported volume score beats a series score; a supported series score replaces a 3-rating
  volume score, with the fallback label.
- A provisional rating is used only when nothing trusted exists, and never makes a Hidden gem.
- Twelve volumes sharing one AniList series score count once in that source's statistics.
- Hidden gems keeps a populated and an empty demo case (M5's done-when); a book sparse on one
  source but popular on another is left out.
- No eligible rating: unknown, neutral in the blend, fails "highly rated".
- A personal rating still overrides; existing scenario tests still pass.

### Before and after

Extend `npm run report:matches` (or add a sibling script) with a title-free comparison of old and
new choices: items that changed rating source, gained or lost a rating, or moved tier, and items
entering or leaving Hidden gems, Classics and Waiting on your shelf. Put the counts in the pull
request.

No migration and no `MATCH_VERSION` change. New constants go in `config.ts` and PLAN.md §20,
marked as assumptions until calibrated against the owner's library.

## Stage 2 — best details from each source (pure, no network changes)

No source is best at everything: Open Library is built for first publication years and ISBNs,
Hardcover for ratings, descriptions and series, AniList for manga tags and volume counts, Metron
for comic issues, Calibre for what the owner curated, and the files for this exact copy. So one
pure function (`lib/details.ts`), used everywhere, chooses each detail separately.

### Rules

- **Display only.** `lib/details.ts` never writes `items.title`, `items.creators` or any other
  column that matching reads to build its search; otherwise a changed title would start new
  lookups. The file's facts stay underneath.
- **Trusted matches only** for facts: owner-confirmed or accepted. Provisional matches offer
  values as suggestions on the book page. Nothing comes from a tie or a rejected candidate, so
  details from two different books are never mixed.
- **Unchanged pools for ranking.** Subjects used by taste, topics and moods, and the kind guess,
  keep today's pool (provisional included) so this stage doesn't shift recommendations. Only what
  is displayed changes. (Revisit after the quality session.)
- **Owner edits win** where they exist (today only the title); then Calibre for title, subtitle
  and authors; then the files; then online sources.

| Detail                 | Rule                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title and subtitle     | Owner's title, then Calibre's, then the file's embedded title, then the strongest trusted online match (confirmed, strong ISBN, then score; Hardcover, Open Library, AniList, Metron as tie-break), then the filename guess. Title and subtitle always come from the same record.                                                                 |
| Authors / creators     | Calibre's, then the file's, then the strongest trusted match's. Comic sources return no creators today, so comics show creators only from files and Calibre (see "Not in this plan").                                                                                                                                                             |
| First publication year | The earliest year among trusted matches. A single issue uses its own cover/store year, never its series' start year (kept apart as the series' start). A collected edition uses the book sources' year for that edition or work, not the years of the issues inside. If trusted sources disagree by more than a year, show each on the book page. |
| Pages                  | Measured from the file first; then a trusted record matched by the file's ISBN; then the strongest trusted match. Labelled with where it came from.                                                                                                                                                                                               |
| Description            | Strip HTML and formatting to plain text first. Hardcover's if it has one of at least `DESCRIPTION_USEFUL_CHARS` (200, an assumption); otherwise the longest from a trusted match. Shown with its source, as text, never HTML.                                                                                                                     |
| Subjects, genres, tags | Displayed: merged from trusted matches and the file, de-duplicated, each with its source.                                                                                                                                                                                                                                                         |
| Series, number, status | Unchanged: `syncSeries` rules.                                                                                                                                                                                                                                                                                                                    |
| Rating                 | Stage 1.                                                                                                                                                                                                                                                                                                                                          |

- **No new requests and no migration:** everything is already stored. Works on existing data the
  moment it is merged; refreshes with stage 4.
- **Before and after:** title-free counts of items whose displayed title, authors, year, pages or
  description changed, and items entering or leaving Classics (year changes). Kind and taste
  topics should show no change; the script confirms it. Search matches both the displayed title
  and the file's.
- **Checks:** a provisional match never supplies a fact; the owner's title wins, then Calibre's,
  then the embedded title; two trusted sources with different titles pick the stronger match; a
  measured page count beats a source's; an issue's year is its cover year even when the series
  started earlier; disagreeing years are both shown; Calibre's HTML description is compared as
  plain text; nothing here changes `items.title` or `items.creators`.

## Stage 3 — "From each source" on the book page

Built once, after stages 1 and 2, so it shows both ratings and details.

- Cards keep one rating, with its source, count and scope, and a short label when it is sparse,
  a series fallback or unconfirmed.
- The book page gets an expandable **From each source** section. **Every source that was asked
  for this book appears**, so nothing is hidden:
  - a matched source: its rating (raw score and scale, number of ratings — a rating count, not a
    review count — and what it rates: book / volume / series), its title, creators, year, pages,
    description and subjects, a link to its page, and when it was last looked up (stage 4 adds
    when the source last actually answered);
  - Calibre, when imported, as its own entry;
  - the values in use are marked, each with its reason ("More ratings for this book", "From
    Calibre", "Earliest year from a trusted source");
  - unconfirmed matches listed apart with the existing confirm action, never shown as verified;
  - a source with no match, no rating, a tie or a failed lookup says so in plain words ("Not found
    on AniList", "Hardcover has no rating for this book", "Open Library couldn't be reached last
    time; will retry"); a source that doesn't apply (AniList for a novel) or isn't set up (no
    Hardcover token) is named once, so the owner knows why it is absent;
  - rejected candidates ("not this book") are not shown: they are other books.
- Phone-width, keyboard, light/dark and reduced motion; `npm run screenshots` and its
  accessibility sweep.

## Stage 4 — automatic refresh, and starting fresh

Built around the existing `LookupManager`, not as a second lookup engine.

### Remember the app's own choices

One numbered migration adds to `lookup_state` (backed up as a whole table, so new columns come
with it; extend `app.release.test.ts` so they are non-empty and survive a restore):

- `accepted_source_id`: the record the app accepted for this item and source. `storeCandidates`
  keeps that row the way it keeps the owner-confirmed one, and `decisionsFor`/`chooseUsed` honour
  it. Background refresh and `MATCH_VERSION` re-scoring never replace it; if a different
  candidate now wins, the current match stays and Needs review gets a "Check this match" entry.
- `last_answer_at`: when the source last actually answered over the network (not a re-read of
  the cache). First filled from `source_cache.fetched_at` where it exists, otherwise from
  `looked_up_at`, then spread across the interval so the whole library is not due at once.
- `next_eligible_at` and `failure_count`, for backoff.

### What is due

From `last_answer_at`, per item and source:

| Item and source                                                                                                                                                                                                         | Every   | Constant               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------- |
| Item in progress or shortlisted (any source)                                                                                                                                                                            | 7 days  | `REFRESH_ACTIVE_DAYS`  |
| A source that rates this kind of book (Hardcover, Open Library, AniList) found no match, a tie or only a provisional match, or gave no rating or fewer than 20 — and the item has no supported trusted rating elsewhere | 30 days | `REFRESH_OPEN_DAYS`    |
| Everything else: settled ratings, sources that never rate (Metron, ComicVine), items already well rated elsewhere, Never and read-elsewhere items                                                                       | 90 days | `REFRESH_SETTLED_DAYS` |

- A failed lookup retries after 1, 3 and 7 days, then returns to its group.
- A ComicVine lookup skipped because Metron found the issue follows Metron's schedule.
- Ongoing series keep the existing 7-day published-series check; refresh shares that work.

### How much, and when

- Check after startup and periodically while running. Nothing runs in demo mode, after shutdown,
  when the setting is off, during a scan, or during a manual lookup.
- Batches of up to 25 requests. One lookup can make several requests (a search, then a record or
  series), and the budget counts every real request. New items and the owner's own actions first,
  then in-progress and shortlisted, then the most overdue. Automatic work uses at most 20% of a
  source's daily allowance where it has one (Hardcover and Metron, 5,000 each). Skip a source
  whose circuit breaker is open and never reset breakers from the scheduler; back off with jitter
  on transient failures; a daily-quota answer pauses the source until the next day. Metron first,
  ComicVine only as fallback, as now.
- After a long time closed, or after a restore, catch up gradually: at most one batch per check.
- The pull request reports the measured requests per day on the demo and an estimate for the
  owner's library size.

### What a background refresh may change

It re-asks the source and re-scores. It may update the rating, count and other facts of the
**same** matched record. It never replaces a confirmed or app-accepted match (Needs review
instead). A record that now has no rating becomes unrated rather than keeping the old one. An
empty, failed or ambiguous answer keeps the previous result and records the failure. Before
saving, re-check that the item still exists and is unchanged (merges, splits and edits during a
request), as manual lookups do. Call `syncSeries` after a batch that changed series facts. Owner
corrections (`user_item`) are never touched.

### Starting fresh (owner's explicit actions)

- **Book page → Look up again** (the existing button and name, enhanced). It already asks every
  source again for this book, ignoring cached answers. It now also lets the app choose its matches
  afresh from the new answers: the app's remembered choices for this book are released. Kept: confirmed matches,
  rejections and the owner's edits. Afterwards it says what changed ("Rating now from Open
  Library, 3,104 ratings"). A source that fails keeps its previous answer.
- **Settings → Online sources → Look up all books again** (new; the server already supports it
  through `POST /api/lookups` with `refresh`). The same for the whole
  library, in the background. A confirmation first says what it keeps, roughly how many requests
  and how long it will take (it can take more than a day because of daily limits), and that a
  snapshot is taken first (like before a restore). Then: progress in the lookup banner;
  cancellable; resumes after a restart; automatic refresh pauses while it runs. Each book's old
  answers stay until its new ones arrive, so cancelling or a failure never blanks a book. Uses
  the normal manual pacing and daily limits, not the 20% automatic cap.
- Neither button ever forgets the owner's confirmations, rejections or edits; those are changed
  only where they are made.

### Controls

Settings: automatic refresh on/off (on by default; off in demo), the three intervals shown
(fixed, from `config.ts`), pause/resume, "Refresh due books now", and Look up all books again. Diagnostics: per source, how many are due, last answer, requests used by automatic work,
pauses and failures. Book page: "Refresh due" and "Refresh failed; showing the previous result";
a refresh never blanks a page.

### Checks (fake clock, no network)

Due selection for each group, including moving between them (started reading → 7 days; rating
became supported → 90 days; Metron-only comics → 90 days); backoff after failures; priority
order; 429, quota and 5xx handling; budget counting every request; cancellation and restart;
demo/off/scan/manual deferral; a removed rating becomes unrated; a failure keeps the old result;
an app-accepted match survives a background refresh and a `MATCH_VERSION` re-score, and a rival
winner adds a Needs review entry; both "Look up again" actions release app choices
but keep confirmed and rejected decisions; a cancelled full refresh leaves untouched books as
they were; everything survives a backup and restore without becoming due at once.

### As built (2026-11-11)

Built as above, with these choices made during the work:

- **A changed search also releases the remembered match.** When the owner corrects a title or
  author (or a scan changes the facts matching reads), the app's earlier choice was made for a
  different search, so the next lookup chooses again. Background refresh and `MATCH_VERSION`
  re-scoring keep it, as planned. Rejecting the remembered record releases it at once.
- **`last_answer_at` is backfilled from `looked_up_at` only.** `source_cache` keys are per query,
  not per book, so they can't say which book an answer was for. Spreading comes from the 10%
  per-book stretch of each interval and from catching up one batch per check.
- **Pause** lasts until Resume or a restart; **off** is the saved setting.
- **Refresh due books now** runs an ordinary lookup run over the due books (all their sources,
  cached answers ignored), shown in the lookup banner.
- New books (never looked up, or with a changed search) go first in each batch, as a manual run
  would look them up, when "Look up new books automatically after each scan" is on.
- **Look up all books again** keeps going across restarts and days: a run interrupted by closing
  the app resumes at the first check after the next start; books a used-up allowance or a failure
  left out are retried the next day; it stops when a pass gets no further (a key that no longer
  works) or the owner cancels it.
- A daily-allowance error is marked on the error itself (`SourceError.quota`), sets the source's
  `next_eligible_at` to the next local midnight, and doesn't count as the book's failure.

## Documentation for every stage

Update PLAN.md (§12 sources and ratings, §20 values, §21 owner actions), README source coverage,
Diagnostics text and the milestone notes. List Windows checks as open items; Linux fakes don't
prove them.

Each pull request must pass `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build` and `npm run report:matches` (0 wrong high-confidence
matches), with `npm run screenshots` inspected for UI changes.

## Owner actions

- **After stage 3 (due now):** the second quality session (§17.2), on the new ratings and details.
  Note how many picks rest on unconfirmed matches (Diagnostics) and confirm any that matter. No
  new accounts or keys are needed for this plan.
- **After stage 4:** with the app open for 10–15 minutes on the Windows PC, check Settings →
  Online lookups → Keeping ratings up to date (a last batch, due books going down) and Diagnostics
  → Automatic refresh (requests within the daily share). Answer any "Check this match" rows in
  Needs review.

## Not in this plan

- **Comic creators from Metron/ComicVine.** Their adapters don't read credits today; adding them
  means extra requests per issue. A separate small change if the owner wants it.
- **Owner edits for authors, year, pages and description.** Only the title can be edited today.
- **Review text** from any source: not wanted.

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
