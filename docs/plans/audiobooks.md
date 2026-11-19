# Audiobooks: local files and Audible

The owner asked for this on 2026-11-17: read the audiobooks saved on the drive, and bring in the
Audible library from Amazon. Read `CLAUDE.md` and `PLAN.md` first; their rules apply here
(invented names in tests, read-only on the library, unknown is unknown, owner corrections win).

## Owner decisions (2026-11-17)

| #   | Question                                              | Answer                                                                                                                                                            |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Are the audiobooks apart from the music on the drive? | Yes, in their own folder. Audio files count as books **only inside folders the owner marks as audiobook folders**, so music is never listed.                      |
| D2  | One file per book, or a folder of parts?              | Not sure. Both are supported; Diagnostics reports what the scan found, as counts only.                                                                            |
| D3  | The same title as an ebook and an audiobook           | **One book, two ways:** one entry, one progress and rating, a reading time and a listening time. Recommended once.                                                |
| D4  | Audiobooks on What next                               | A **Read / Listen / Either** choice. Either (the default) mixes them; Listen shows only audiobooks and fits the time by playing time; Read leaves audio-only out. |

Not asked, decided by the existing rules: Audible gets a collector like the other stores (the
owner ruled out waiting on official exports), built from the owner's look-around report, never
from guesses.

## Stage 1: local audiobooks (built 2026-11-17)

- **Audiobook folders.** `folders.audiobook_dirs` (migration 021) is a JSON list of directories
  below a library folder (`''` is the whole folder). Settings → Library folders → **Add a folder
  of audiobooks** takes a path: a library folder, a folder inside one (remembered on that library
  folder, since library folders can't nest), or somewhere new (it becomes a library folder).
  `addAudiobookFolder` / `removeAudiobookDir` in `scan/folders.ts`. **Stop** takes a directory off
  the list: its audio files leave the library (nothing on the drive is touched), books that were
  only audio go unless the owner recorded anything on them, and a book that also has an ebook
  keeps it.
- **Light pass.** Inside an audiobook directory, `.mp3 .m4b .m4a .aac .flac .wav .ogg .opus .wma
.aa .aax` get the format `audio`. Elsewhere they are ignored as before.
- **Which files make one book** (`identify/audiobook.ts`, pure, from names only):
  - names with explicit part markers ("Title Part 1", "Title Part 2") are one book, named by
    what they share; bare trailing numbers remain part of the title in every format, since
    "Title 3" and "Title 4" may be separate books (owner decision in the second PR review);
  - files that start with a clear track number and chapter name ("01 - Dawn") are chapters of
    the book their folder is named for; so are explicit track names ("Track 03") and short
    zero-padded track numbers ("01", "02"). Other numeric titles keep their digits;
  - a "CD 1" / "Disc 2" folder takes its book from the folder above, so discs join up;
  - `.m4b`, `.aa` and `.aax` hold a whole book each: numbered ones are books in a series, joined
    only by a named part ("Title Part 2.m4b");
  - anything else is a book of its own.
    The book's name is what the filename parser reads (`files.parsed`, `compare_key`), and
    `files.book_dir` holds the book's folder. Parts group by folder + `book_dir` + `compare_key`
    (`sameAudiobook` in `identify/grouping.ts`). A wrong grouping is fixed with the existing merge
    and split.
- **Deep pass.** `scan/formats/audio.ts` reads tags and the playing time with `music-metadata`
  (pure JavaScript, MIT, no install script). Formats with a stated playing time need only
  headers; MP3s without a usable duration header count frames to the end, so variable bitrate
  is never mistaken for constant bitrate from the first few frames. The album is the book's title, the
  album artist (else artist) its author; a narrator is never guessed. `files.duration_seconds`
  holds the time. Old Audible `.aa` files can't be read: listed, length unknown. Audio is **not
  fingerprinted in full** (hundreds of gigabytes; copies need the same book key as well as the
  same filename and size, so a shared publisher clip cannot join different books). One
  cover per book, from its first part.
- **Listening time.** `listenFromFiles` (`lib/library.ts`): the parts added up, each part once
  however many copies or encodings exist (same relative path and filename stem within the book;
  disc directories and chapter numbers stay distinct), and **unknown while any part's time is unknown**. It is exact, so it
  is shown without "~" or a range ("9 h 12 min to listen"). `Duration.listening` marks it.
- **One book, two ways.** An audiobook beside an ebook of the same name joins it by the normal
  same-name rule; the ebook stays the file that opens. In different folders they are two entries
  until both are matched online to the same book, when Needs review offers the merge (the
  existing same-match rule). `ItemSummary.media` says read / listen.
- **What next.** `Situation.medium`, `hasMedium` and `forMedium` in `lib/recommend.ts`; the
  shared pool filters by it. Listen swaps every length for the playing time. A book that can be
  read keeps its reading time and its card adds "Or listen: …". "Why not?" explains the filter.
  The choice shows only once the library holds an audiobook.
- **Diagnostics** → Audiobooks: folders, files by type, books of one file and of several, the
  largest book, files with no playing time. Counts only, safe to share.

## Stage 2: Audible

Built 2026-11-17:

- **Audible is a store** (`STORES`, migration 021 rebuilds `locations` and `store_purchases` for
  the new name): add by search or by hand, the spreadsheet (`store` = audible), the Store filter,
  links on Audible's own sites ("Listen in Audible ↗"; `/webplayer` is the player).
- An Audible copy can carry a **length** the owner types as Audible shows it
  (`locations.listen_minutes`). An Audible-only book counts as something to listen to.
- Settings → Import store purchases lists **Audible (not available yet)** with the look-around
  steps (`LOOK_AROUND_ONLY` in `lib/storePurchases.ts`).

Waiting on the owner (B2): the look-around report from the Audible library page. Then:

- `tools/store-collector/adapters/audible.ts`, built from that report: which of Adapter /
  CardAdapter / WatchAdapter fits, how purchases differ from Plus-catalogue and podcast titles,
  whether the page states a length, and the reader link. Add `audible` to `SERVICES` and `Service`,
  a bookmark button, fixtures with invented titles, and owner checks like A2/A3.
- The import fills `listen_minutes` when the page states a length.

## Owner actions

| #   | When          | What                                                                                                                                                                      | Time   |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| B1  | Now           | Update the app, add the audiobook folder in Settings, scan, and look at a few audiobooks (owner checklist, "Audiobooks"). Send the Diagnostics report.                    | 15 min |
| B2  | Now           | On audible.com, signed in: run the look-around script on your library (Settings → Import store purchases → Audible), and paste the report into chat. No titles are in it. | 5 min  |
| B3  | After Stage 2 | Run the Audible bookmark button on your library and import the file.                                                                                                      | 10 min |

## Needs checking on the owner's machine

- Real audiobook folders: are parts grouped into the right books (D2)? The Diagnostics counts
  and a few spot checks answer it.
- Real tags: does the album give the book's title, or do some files need the folder's name?
- Scan time on the USB drive with many audio files, especially MP3s without a duration header
  (these need a frame scan; a timed-out read leaves the length unknown).
- **Open** on an audiobook starts its first part in the default player.

## PR #30 review fixes

- Stats keeps audiobook counts in the backlog, but leaves listening time out of estimated
  reading time, including for books in progress. A book available both ways contributes only
  its reading estimate. The table explains this and labels its reading-time coverage.
- Alternate encodings with the same path and filename stem count as one part. File size and
  extension do not make an extra chapter. The longer known duration is used when encodings
  differ slightly; a known encoding can supply the length of an unreadable alternative.
- MP3s without a usable duration header are measured by counting all frames, rather than
  assuming constant bitrate from the opening frames. Usable Xing/Info headers still stop early.
  Metadata stage 4 rechecks existing audio on the next scan; other current formats stay cached.
- The book page’s **Also in → Audible** form accepts optional hours and minutes, just like
  adding a new title. Leaving both blank keeps the length unknown.
- Page tests cover the Settings audiobook-folder form (pending, success, error and retry),
  Read / Listen / Either (default, requests, bookmarks and visibility), and Audible lengths
  for both new titles and existing books. Server regressions cover totals and MP3 durations.

Real-file grouping, tags, USB scan speed and Windows playback still need owner checks 24–29.
Passing Windows CI exercises generated files and cannot confirm those checks. Audible import
still waits on action B2; these fixes do not add a collector.

## Second PR #30 review

All nine findings reproduced in regression checks. Qualifications: the never-finished hash
count is separate from the actual error badge, and a bare trailing number cannot prove whether
an MP3 is a chapter or a book in a series. The owner chose separate books for ambiguous names.

| Findings | Change                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 7     | Health excludes audio from pending full hashes and includes audio in pending metadata reads. Its list of readable formats comes from the same configuration as the scanner.                                                   |
| 2, 3     | Numeric titles retain their numbers; explicit part markers preserve numbers in the book title. Ambiguous trailing numbers stay separate. Parser version 7 re-reads names on the next scan.                                    |
| 4        | Audio copies must share the book's compare key; matching credits/intro clips do not join different books. Legitimate copies of the same book still group.                                                                     |
| 5        | A stated Audible length supplies the total when local playing time is unknown or incomplete. A complete local length still takes precedence; the displayed basis follows the chosen source.                                   |
| 6        | Migration 022 adds a partial index on `(folder_id, book_dir, compare_key)` for active audio. A query-plan check verifies that all three keys are used.                                                                        |
| 8        | Existing Audible entries have Add/Change/Remove length. PATCH accepts a validated length or explicit null; omitted values preserve the previous length, including during imports.                                             |
| 9        | Removing an audiobook directory returns the deleted file ids. Their cached covers are removed from the app's data folder after the database transaction commits; covers for retained files and the owner's recordings remain. |

Tests use invented titles and generated files, and cover grouping on both the initial scan and
later scans, complete/incomplete local audio with Audible, atomic validation, clearing versus
omitting lengths, cover cleanup, and the page's error/retry path. The browser script exercises
changing, clearing and restoring an Audible length in both themes at desktop and phone sizes.

## The owner's real layouts (listing shared 2026-11-19)

The owner shared folder and file names from their audiobook folder; they stay out of the repo.
Title-free summary: about 2,800 MP3s, 9 old Audible `.aa` files, plus a few
playlists, covers and text files. Two top-level areas: an Audible download folder and a folder of
Humble audio comics. The owner's copy of the app was older than Stage 1, so nothing was scanned
yet (the scan listed the MP3s under "Other files ignored").

Running invented copies of each pattern through `audioBooksInDirectory` (Stage 1 rules):

| Pattern (invented example)                                                        | Stage 1 result                        |
| --------------------------------------------------------------------------------- | ------------------------------------- |
| `00 - Prologue.mp3`, `1-01 Chapter.mp3`, `Title CD1-01.mp3`, `Title - Disc 1.mp3` | one book ✓                            |
| `Disc 2/01 - Chapter.mp3`                                                         | one book ✓                            |
| `Series - Book 1 - Title - 00 - Prologue.mp3`                                     | one book per file ✗                   |
| `TitleTMUnabridgedPart1_mp332[_user].mp3/.aa` (Audible download names)            | one per file, raw name as title ✗     |
| `Author - Title - 1 of 4.mp3`, `Title - Author (01 of 08).mp3`                    | one per file ✗                        |
| `0.00.1 Credits.mp3`, `01 0301.mp3`, `01(4) Title.mp3`, `B02-01-12 - Title.mp3`   | one per file ✗                        |
| `Title (Author) [01] -- Chapter.mp3`, `Chapter 01 - Name.mp3`                     | one per file ✗                        |
| `Title 01.mp3`, `Title 02.mp3` in a folder named Title                            | one per file ✗ (owner rule: kept)     |
| `001_ 01_(1 51) Title (Unabridged) Part 1_Author.mp3`                             | one per file ✗                        |
| `CODE521P01.mp3` (Humble audio comics)                                            | one per file ✗                        |
| `Title Disc 3/…` (title before "Disc N")                                          | one book per disc ✗                   |
| `Title Disc 1/Title/1 - Track.mp3` (book folder inside the disc folder)           | one book per disc ✗                   |
| The same book twice in two folders with different names                           | two entries until matched (by design) |

Only about a third of the patterns grouped correctly.

### Folder first (owner decision 2026-11-19, built; parser version 8)

The owner chose the folder-first rule, replacing the 2026-11-17 rule that kept "Title 3" and
"Title 4" apart. In `identify/audiobook.ts`:

- A folder holding two or more numbered audio files that start with a number, or share at least
  `AUDIO_CHAPTER_SHARED_LETTERS` (4) opening letters, is one book named after the folder;
  unnumbered files beside them ("Credits") join it. Separate books keep their own folders, and
  whole-book files (.m4b/.aa/.aax) stay apart unless a named part joins them. In the library
  folder itself only files starting with a number are chapters (its name rarely names a book).
- Files whose only difference is a named part ("Title Part 1/2"), with nothing else beside them,
  keep their shared name rather than the folder's.
- "Title Disc 3" folders, a title folder inside a disc folder ("Ember Disc 1/Ember") and generic
  folders ("Audiobook", "MP3") give way to the folder above; a titled disc folder names the book.
- Folder names lose a leading list number ("02 - Author - Title") and "unabridged"/"audiobook"
  (`tidyBookName`). "Book 01 - Title" keeps its number for the parser's series number.
- Audible download names lose the codec and account suffix and get their spaces back
  (`cleanAudibleName`: "TitleUnabridgedPart1_mp332_account" → "Title", Part 1 and 2 joined).
  Run-together lower-case words stay joined ("Whatthe"); the online lookup and tags cover it.

Review of PR #31 (both reproduced, both fixed):

- **Books already scanned regroup.** `regroupAudiobookParts` (`identify/reconcile.ts`) runs after
  each light pass on the re-read audio files: parts that now share a book key but sit in separate
  items are merged into the one holding the owner's data (else the one with most parts, else the
  oldest). Owner corrections win: items from an owner's split are left alone, and when two items
  both hold owner data they're suggested in Needs review (tier 2) instead.
- **Mixed chapter styles** ("01 - Dawn", "02 - Dusk", "Chapter 3") count as chapters: each name
  only needs a chapter mark of some kind. Leading-number chapters beside an unrelated numbered
  file still join the folder's book.

Second review of PR #31 (all three reproduced, all fixed):

- Regrouping never joins items whose files have a known language or edition conflict.
- A merge suggestion stores one file from each book, so it isn't marked obsolete at once.
- The owner's splits are kept in `owner_splits` (migration 023, backed up), not only in the
  20-entry undo history: regrouping never joins files split apart. Undoing the split removes it.
- `PARSER_VERSION` is now really 8 (the earlier commit's bump hadn't applied; audio names are
  re-read on every scan anyway, so grouping wasn't affected).

Every pattern in the table above now groups into one book per book (invented copies in
`audiobook.test.ts`, plus a full scan of nested disc folders in `app.audiobooks.test.ts`). Still
open: the same book in two differently named folders stays two entries until matched; a book whose
discs sit in folders with different names ("Title" and "Other Title Disc 3") can split; titles from
"Author - Title" vs "Title - Author" folder names can't be told apart by name (album tags win when
present). Needs checking on the owner's drive (B1).
