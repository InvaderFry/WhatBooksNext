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
  - names that differ only by a number or a part word ("Title Part 1", "Title 02") are one book,
    named by what they share;
  - files that start with a track number ("01 - Dawn") are chapters of the book their folder is
    named for; so are files that are nothing but a number ("Track 03");
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
  fingerprinted in full** (hundreds of gigabytes; copies are recognised by name and size). One
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
