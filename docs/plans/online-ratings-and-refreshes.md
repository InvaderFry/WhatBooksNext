# Online ratings, alternative sources and automatic refreshes

Status: implementation plan; no application changes made. Researched 2026-11-10.

## Agreed scope

- Keep Open Library, AniList, Hardcover, Metron and ComicVine.
- Choose a community rating using match confidence, sample size and what the rating covers.
- Show the other source ratings and explain the selected one.
- Refresh automatically while the app is running: every seven days for currently reading or
  shortlisted items, every 30 days for the rest, in small batches.
- Add optional Google Books support, including API-key setup in Settings. The owner approved
  this setup route; the key is entered in the app, never in chat.

This extends PLAN.md §12 and replaces its fixed rating-source order when implemented. Existing
personal ratings, confirmed identities, rejections, reading history and manual scans keep their
current authority. Missing community ratings remain neutral.

## What the current implementation needs

`sources/index.ts` already routes by format. `identify/lookups.ts` queries those sources and
keeps their selected records. `lib/ratings.ts` chooses Hardcover before AniList before Open
Library regardless of vote count or match quality. `lib/rankData.ts` supplies that selection to
recommendations. `routes/reading.ts` and `web/src/pages/OnlineCard.tsx` expose one community
rating. Ordinary source cache entries and completed lookup states have no age-based expiry.

The matching score is a heuristic, not a probability. The new policy must not describe 0.90
as a 90% chance of being correct or multiply it by the number of votes as if it were one.

## 1. Represent the evidence and choose a rating

Extend the rating input with the source record ID, match decision/evidence, owner confirmation,
rating target, source link and actual last successful network check. Retain each raw rating,
scale and count. Keep missing counts distinct from zero.

Distinguish an edition, an individual book/collected volume and an entire series. Google calls
every catalog record a "Volume"; that alone does not mean a numbered comic/manga volume.
Store a target ID where available so the same AniList series rating attached to many owned
volumes is counted once in source statistics. Never add together votes from editions or sites.

Proposed deterministic selection policy:

1. Exclude rejected records, unresolved ties, invalid ratings and records that conflict with
   the item's identity, number, run or known edition. A confirmation for one source does not
   automatically confirm another source's record. Require independent agreement for alternatives.
2. Use owner-confirmed or automatically accepted matches for the main community rating and
   recommendation component. Show provisional matches as unconfirmed alternatives, without
   allowing a popular but uncertain match to drive recommendations. If nothing qualifies,
   the community component is unknown/neutral.
3. Start with a configurable minimum of **20 votes** for a supported sample. This is a proposed
   product default, not a statistical guarantee. Prefer a supported individual-book/volume
   score; otherwise a supported series score can be a clearly labelled fallback for an item
   verified to belong to that series. Otherwise use the best sparse eligible individual score,
   then a sparse series fallback. Label sparse or unknown-count evidence explicitly.
4. Within the same scope/sample tier, prefer stronger matching evidence, then greater known
   vote support. Cap the vote comparison at 1,000 initially so enormous popularity does not
   provide unlimited advantage. Use the legacy source preference only as a final stable tie
   breaker: Hardcover, AniList, Google Books, Open Library, demo.
5. Preserve source-specific Bayesian adjustment and source-relative "highly rated" thresholds.
   Compute their statistics from eligible, deduplicated rating targets. Never average different
   sites into a combined star rating. Keep raw displayed values unchanged. Personal ratings
   continue to override the community component in recommendations.

Return the primary rating, eligible alternatives, excluded/provisional alternatives and concise
reason codes from one pure selector. Use that same output for item details and recommendations.
Calibrate the proposed 20/1,000 constants against edge-case fixtures and a private sample before
finalizing them; place them in config.ts and record them in PLAN.md §20.

Acceptance examples using invented fixtures:

- A securely matched Open Library book with 3,000 votes beats the same book's Hardcover score
  with three votes.
- A million votes cannot rescue an uncertain or wrong-volume match.
- A supported manga volume score wins over a series score; a supported series score can replace
  a three-vote volume score, with "Whole series; individual volume has few ratings" visible.
- No eligible source rating means unknown, not a fabricated score or zero.

## 2. Show alternatives and freshness

Keep the chosen score on recommendation cards with its source, count and scope. On the item
page, add an expandable "Ratings by source" list showing raw score/scale, number of ratings,
book/edition/volume/series target, match status, source link and last successful check. Mark the
one used for recommendations and give a short reason, such as "More ratings for this book".
Show uncertain matches separately with a confirm action; do not present them as verified facts.

Expose "Few ratings", "Vote count unavailable", "Whole-series fallback", "Refresh due" and
"Refresh failed; showing the previous result" where applicable. Refreshing or a provider failure
must not blank the page. Distinguish a rating count from a count of written reviews.

Settings should expose automatic refresh on/off, the agreed intervals, pause/resume and
"Refresh due items now". Diagnostics should show per-source pending work, last success, request
usage, quota pauses and failures. Keep explanations in ordinary language and make the source
list usable on phone, with keyboard access, light/dark and reduced motion.

## 3. Refresh without rescanning or exhausting quotas

Add a small scheduler around the existing LookupManager, not a second concurrent lookup engine.
Check due work after startup and periodically while running. Run no background work in demo
mode, after shutdown or when automatic refresh is disabled. Defer automatic batches during
scanning/manual lookups. Resume overdue work gradually after a long period with the app closed.

- Persist last attempt, last successful network check, retry-after/next eligible time and failure
  state per source/query or matched record. Separate those times from local candidate rescoring.
- Fetch only due sources. Deduplicate shared queries and series IDs across items. Prefer stable
  record-ID refresh where a provider supports it; otherwise re-search and reconcile cautiously.
- Start with batches of up to 25 due source jobs, constrained by remaining per-source request
  budgets. Newly added items and explicit user actions take priority, then active/shortlisted
  items, then the oldest due backlog. Reserve most daily capacity for manual/new-item use;
  initially allow automatic refresh to consume at most 20% of the configured daily allowance.
  Enforce budgets on actual requests, including secondary lookups, not just item counts.
- Reuse pacing, Retry-After, quota checks and circuit breakers. Automatic batches must not reset
  circuit breakers repeatedly. Retry transient failures with bounded backoff and jitter; daily
  quota exhaustion pauses that source rather than repeatedly retrying it.
- Explicit refresh bypasses a fresh cache; normal reuse does not. Preserve actual response dates
  so parsing an old cached answer cannot make it appear freshly checked. Use conditional requests
  where supported. Cache expiration and scheduling are distinct, provider-specific policies.
- Failures retain the last usable result where provider retention rules permit. A valid refreshed
  record that no longer has a rating becomes unrated; it must not silently keep its old rating.
  Empty/ambiguous searches do not silently replace a confirmed identity. Keep the previous match
  with a verification warning and schedule review/retry.
- Recheck the current item/query before committing a response, preserving the existing protection
  against merges, splits and edits while requests are in flight. Preserve owner decisions.
- Keep Metron first and ComicVine as fallback. Refreshing does not mean calling both every time.
  Coordinate with existing seven-day published-series checks so requests are not duplicated.

A fresh-install backfill starts gradually and is resumable. No library file reads or scheduled
file scans are needed. The app cannot refresh while it is closed; it catches up when reopened.

## 4. Google Books research and integration

### Finding

Google Books is technically suitable as an optional sixth catalog/ratings source. Its public
API provides search and record retrieval. Useful fields include ISBNs, authors, categories,
description, edition publication date, pages, language, averageRating and ratingsCount. These
fields are optional. There is no general public review-text collection in the Volume resource;
userInfo.review refers to an individual user's review. This does not guarantee Amazon-sized
rating coverage or provide Amazon/Goodreads reviews.

Official setup identifies public requests using an API key or OAuth token. Use a Books-enabled
Google Cloud project and a server-held API key; OAuth/library syncing is unnecessary for this
feature. The original PLAN.md claim that keyless low-volume use is sufficient is not the setup
we should rely on. Verify the owner's actual daily/minute quotas in Cloud Console rather than
promise a fixed universal quota or automatic quota increases. No key exists in this environment,
so authenticated responses, live coverage and project quota have not been verified.

### Adapter and routing

- Add `googlebooks.ts` using the existing SourceAdapter and polite client. Search with `isbn:`
  first when available, then a bounded `intitle:`/`inauthor:` query; permit a bounded plain-text
  fallback if constrained search finds nothing. Compare title, author, language, edition and
  volume/omnibus numbers using the shared matching rules. Do not select the first hit blindly.
- Use GET /books/v1/volumes with printType=books, relevance order, a modest maxResults and a
  fields mask that retains ratings/counts and required attribution/link information. Use
  GET /books/v1/volumes/{id} for matched-record refresh. Sanitize descriptions as plain text.
- Add Google Books alongside the book sources for books, collected comics and manga volumes,
  paced under its own quota. Do not restrict it to "nothing else matched": it must have an
  opportunity to supply a better-supported rating even when Hardcover found the book.
  Automatic single-issue identification continues to use the comic sources.
- Treat publishedDate as this edition's date, not the work's first publication year. Use pages
  only for the matched edition, with provenance. Prefer measured local length information.
  Do not import Google series completion/order claims that the API does not supply.
- Add enable/disable, masked-key storage, connection test and usage/error status to Settings and
  Diagnostics. Keep the key in secrets and redact key= parameters from errors/logs; exclude keys
  from backups, fixtures, browser responses and committed files. Restrict the key to Books API.
- Run a private, small keyed pilot across books, collected comics and manga. Measure matching
  precision, availability of ratings/counts, useful metadata gained, votes compared with existing
  sources, duplicate editions and requests per usable match. Record only title-free summaries
  publicly. Keyed smoke/coverage checks are validation work, not a prerequisite for drafting code.

### Provider-specific requirements

Google requires attribution and prominent links. Show its search results in a separate branded
group in Google order, not interleaved/reordered with other providers. Distinguish Google's raw
results and ratings from the app's own recommendation explanation. Preserve original values.

The existing indefinite cache is unsuitable: Google's general terms restrict permanent copies
and caching beyond allowed headers. Implement provider-specific retention before enabling Google
in normal use: inspect real response headers, expire/purge both raw and normalized Google-derived
content, and exclude expiring Google content from permanent backup snapshots unless permitted.
Keep owner-entered data separate. Verify how derived recommendation use fits the published rules;
if a planned persistent use is not permitted, use on-demand retrieval/attributed links for that
part rather than assuming blanket storage permission. Do not repeatedly fetch expired content
beyond quotas. Google Books also restricts charging for an application without separate
permission; this plan targets the existing personal-use app.

Official sources checked on 2026-11-10:

- [Using the API: credentials, query operators and location behavior](https://developers.google.com/books/docs/v1/using)
- [Volume fields: metadata, ratings and user review](https://developers.google.com/books/docs/v1/reference/volumes)
- [Volume search](https://developers.google.com/books/docs/v1/reference/volumes/list)
- [Get a volume](https://developers.google.com/books/docs/v1/reference/volumes/get)
- [Attribution, linking and search-result presentation](https://developers.google.com/books/branding)
- [Google API content and caching terms, section 5](https://developers.google.com/terms)
- [Google Books additional terms](https://developers.google.com/books/terms)

## 5. Implementation sequence and verification

1. Extend provenance/target/freshness data and add any numbered SQLite migration. Define backup
   inclusion/exclusion and restoration defaults, especially Google's expiring content. Recompute
   rating choices from stored data without a network-wide forced refresh. Change MATCH_VERSION
   only if identity matching/derived source parsing changes, not just for a rating-policy change.
2. Implement the pure selector, source-statistics deduplication and API response, then the
   alternative-ratings UI. Verify that personal ratings and unknown-as-neutral still work.
3. Add Google Books, credential setup, attribution/presentation, provider cache policy and
   network-free adapter fixtures; perform the optional keyed pilot when the owner enters a key.
4. Add the scheduler, persisted due/retry state, source budgets and refresh controls. Roll out
   with small batches and visible progress; ensure clean cancellation/shutdown.
5. Update PLAN.md §12/§20, README source coverage, notices, setup instructions, Diagnostics and
   milestone notes to describe final behavior and any live checks still outstanding.

Meaningful checks: selector scenarios above; invalid/missing counts; a wrong omnibus; Google
edition-date isolation; multiple editions without vote summing; the same manga score attached
to multiple volumes; provisional alternatives; unknown ratings; retry after 429/403 quota/5xx;
malformed responses; correct cache expiry and purging; successful removal of a rating; failed
refresh retention; restart/cancellation/deduplication; manual work priority; disabled/demo modes;
and preserving confirmed/rejected matches through refresh and restore. Tests use invented
network-free fixtures and a fake clock. Live coverage evidence stays separate from fixture tests.

Run the repository checks (tests, typecheck, lint, formatting, web build and match-quality
report), inspect demo screenshots, and exercise the new controls in a real browser. Record the
Windows check and authenticated Google pilot separately; neither is proven by Linux fakes.

Done means all existing five still work, Google can be enabled with a key, the rating choice is
explainable and scope-aware, alternatives are visible, due work refreshes within quotas, failures
preserve permitted useful data, and owner corrections remain intact.
