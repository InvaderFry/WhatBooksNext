# Reading-history CSV fixtures

The books, identifiers, reviews and reading history in these files are invented. The headers
follow the public export samples in BookWyrm's test suite, inspected during this work:

- [Goodreads sample](https://github.com/bookwyrm-social/bookwyrm/blob/9dc897e466b02da2a4fd62b5644b2e5fdaa9c051/bookwyrm/tests/data/goodreads.csv)
- [StoryGraph sample](https://github.com/bookwyrm-social/bookwyrm/blob/9dc897e466b02da2a4fd62b5644b2e5fdaa9c051/bookwyrm/tests/data/storygraph.csv)

Only the field layout is reproduced; no reading records or implementation code were copied.
The Goodreads sample demonstrates Excel's `="ISBN"` wrapper and year-first slash dates.
The StoryGraph sample demonstrates `ISBN/UID`, multiple authors in a quoted field, status,
zero or decimal ratings, blank finish dates, and `Owned?` (which is deliberately ignored).
[This exporter's conversion script](https://gist.github.com/jenny-codes/19aa14b57672c8892d30003e6f0e2b5b)
independently confirms the StoryGraph status, rating, review and date field names.

These are public compatibility examples, **not freshly generated authenticated exports**.
Current exports from both services still need a real-user spot-check. Extra columns are ignored;
missing identifying headers cause a clear error instead of guessing the source. Dates accept
`YYYY/MM/DD`, `YYYY-MM-DD`, year/month or year alone; StoryGraph also accepts day-first slash
dates. Unrecognised or invalid dates stay unknown and are reported. `Date Added` is never a
reading date. `Dates Read` is not expanded: the app stores one reading, using `Last Date Read`.
