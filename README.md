# whatBooksNext

Helps one person choose what to read next from a large, messy collection of ebooks and comics
they already own. A local web app for Windows: it scans your folders, works out what each file
is, ranks your to-be-read pile, and tracks progress with one tap.

**Status: Milestone 0.** No app yet. The full plan is in [`PLAN.md`](PLAN.md).

## Milestone 0: the Windows probe

Before building anything, a small read-only script checks the plan's riskiest assumptions on
a real Windows PC: iCloud online-only files, drive identity and real filename patterns. See
[`tools/probe/README.md`](tools/probe/README.md) to run it on your own PC. It never changes
your files, and the report is plain text that you read before sharing.

Milestone notes are in [`docs/milestones/`](docs/milestones/).

## Licence

PolyForm Strict 1.0.0 (added in Milestone 1). You may read the code and run it for yourself,
but not change or redistribute it.
