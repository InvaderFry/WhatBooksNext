# Owner checklist: quality session and Windows checks

**Status: not done yet (saved for later, 2026-11-14).** Nothing else waits on it: other work
carries on, and anything new to check gets added here.

Everything here is done in the app on your Windows PC with your USB drive. No command line is
needed. Allow about **20 minutes** for part 1 and **25 minutes** for part 2. They can be done on
different days.

When you're done, send the results in chat. Book titles are fine there: they're never committed to
this public repository. Only a title-free summary goes into `docs/quality-summary.md`.

## Before you start: update the app

Do this once [pull request 23](https://github.com/InvaderFry/WhatBooksNext/pull/23) is merged, so
you're checking the newest version.

1. **Settings → Download a backup**, just in case.
2. Close the black window.
3. Download the new version (green **Code** button → **Download ZIP**) and unzip it into a **new**
   folder.
4. Copy the `data` folder from the old app folder into the new one.
5. Double-click `start-whatBooksNext.bat` in the new folder.

## Part 1: the second quality session (about 20 minutes)

The goal is to judge whether the picks are _good_, not just correct. For each situation below, set
it up on **What next**, then look at the **top 5** picks.

| #   | Situation                        | How to set it up on What next                                                                    |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | 30 minutes tonight               | _What are you after?_ **Read next**; _How long have you got?_ **30 min**; **Read for that long** |
| 2   | Something to finish this weekend | **Read next**; **A weekend**; **Finish something in that time**                                  |
| 3   | Continue a comic                 | **Continue reading** (or **Next in series**); _What kind?_ **Comics and manga**                  |
| 4   | Learn something                  | **Mood** → **Learn**                                                                             |
| 5   | Surprise me                      | **Surprise me**; try **Reroll** two or three times                                               |

For each situation, note:

- **Yes or no:** do the top 5 include something you'd actually start this week?
- **Anything wrong** you had to correct first (wrong book, wrong series, wrong kind, wrong length).
- **Why you passed on the others.** Press **Not this, because…** on picks you'd reject. The
  app keeps those answers, so you don't have to write them all down.

**Target:** a "yes" in at least 4 of the 5 situations. A "no" isn't a failure; it tells us what to
fix next (matching, missing data, ranking weights, or a mode).

## Part 2: Windows checks on your drive (about 25 minutes)

Mark each one **worked**, **didn't work** (say what happened), or **skipped**.

### Opening books

1. With the USB drive plugged in, open one **EPUB**, one **PDF** and one **CBZ** comic from their
   book pages with **Open**. Does each open in your usual reading app?
2. On one of them, press **Show in folder**. Does File Explorer open with that file selected?
3. Go to **Settings → Diagnostics**. Under the Open line, does it say the last Open worked?

### Unplugging and plugging back in

4. Close any book you have open, then safely remove the USB drive. Reload the **Library** page. Are
   your books still there, labelled **On external drive (not connected)**, with your progress unchanged?
5. Press **Open** on one of them. Does the app say "The external drive is not connected" (rather than
   a confusing error)?
6. Plug the drive back in and run a scan (**Settings → Library folders → Scan now**). Do the books become
   available again, with nothing duplicated?

### A changed drive letter

This checks that the app finds your drive even if Windows gives it a different letter. You'll put
the letter back at the end.

7. Right-click the **Start** button → **Disk Management**. Right-click your USB drive (`E:`) →
   **Change Drive Letter and Paths…** → **Change…**, pick another free letter (for example `F:`) and
   confirm.
8. In the app, run a scan. Is your folder found on the new letter, with no duplicate books and
   your progress kept?
9. Change the letter back to `E:` the same way, and scan once more.

### Backups and exports

10. **Settings → Export and snapshots → Take a full snapshot**. Then look in the app's
    `data\full-snapshots` folder: is there a new folder with a `README.txt` and a `covers` folder
    inside?
11. **Settings → Export and snapshots → Download as CSV**, and open the file in Excel. Do titles
    with accents (é, ü, etc.) look right, and do any notes starting with `=` or `+` show as plain
    text rather than formulas?

### Things that run in the background

12. Leave the app open for 15 minutes. Then go to **Settings → Online lookups → Keeping ratings up
    to date**. Does it show a last batch?
13. Open a book in **Needs review** and press **Generate page previews** for a PDF, an EPUB and a CBZ
    from the USB drive. Do the first pages appear?

### Comic runs (new: "Which run is it?")

14. After updating, wait for the lookups to finish, then open **Needs review**. Is there a
    **Which run is it?** section? Pick the right run for one series you know (look at a cover
    on Metron if unsure). Do that series' issues leave the list?
15. Find a comic whose filename includes a year (like "series1992_issue1") that was tied before.
    Is the run that began that year now offered? And for a series that has a spin-off with a
    subtitle ("Series: Other Name"), are its issues now matched to the series itself (as
    unconfirmed) rather than tied with the spin-off?

16. Plug in the drive and click **Scan now**. When it's done, find a PDF comic or art book
    whose cover was a grey or blank page. Does it show its real cover now?
17. In **Which run is it?**, does each choice show a cover and a **View on Metron** link?

### Library folders and long lists (new: review fixes, Stage 1)

18. **Settings → Library folders → Add a folder**: paste the path of a folder _inside_ your books
    folder (for example `E:\My Books and Comics\Comics`, if you have one). Does the app refuse it
    and name `E:\My Books and Comics`? Try it once in lower case too
    (`e:\my books and comics\comics`). Nothing should be added.
19. Paste `E:\` (the whole drive). Is it refused, naming your books folder?
20. Open **Needs review** → **Library health** (the link near the top). If a section **Folders inside other folders**
    appears, tell me which two folders it names; don't remove anything yet.
21. In **Library**, keep pressing **Show 100 more** until the button goes away. Does the count
    under the list end at your full number of books (it used to stop at 1,000)?
22. On a book you're reading, try to set its **Started** date to next year. Is it refused with
    "The start date is in the future"? Your current dates on other books are left as they are.

23. Open a store book (one without a file) that showed a cover before you updated. Does it
    still have one? And after the next lookups, do newly added store books get covers as before?

### Audiobooks (new, 2026-11-17)

Do these after updating the app. They are also action B1 in `docs/plans/audiobooks.md`.

24. **Settings → Library folders → Add a folder of audiobooks**: paste the path of the folder
    your audiobooks are in (in File Explorer, right-click the folder → **Copy as path**). It can be
    a folder inside `E:\My Books and Comics`. Is it listed under that folder with a 🎧?
25. Press **Scan now**. When it finishes, open **Library** and set **Format** to **Audiobook**.
    Pick three audiobooks you know. For each: is it **one** entry (not one per chapter file), is
    the title right, and does the listening time look right? If a book has the same filename
    in two formats (such as MP3 and M4B), check that its time counts once. MP3s without a duration
    header now need a frame scan: note how long the scan takes on the USB drive.
26. Is any **music** listed as a book? (There shouldn't be any.)
27. On **What next**, choose **Listen** under _Read or listen?_ Do only audiobooks show, with
    their listening times?
28. Open an audiobook's page and press **Open**. Does it start playing in your usual player?
29. If you own a title as both an ebook and an audiobook: is it one entry or two? (Two is
    expected when they're in different folders; tell me, and whether **Needs review** offers to
    merge them.)

On **Stats**, audiobook-only entries should count in **Waiting**, but their playing time
should not add to **Estimated reading time**. On an existing book’s page, **Also in → Audible**
now has optional **Hours** and **Minutes**. Check one length you know from Audible. The Audible
entry also has **Change length** and **Remove length**; removing it should show “unknown” unless
a complete local recording supplies a playing time. Numbered MP3 book titles should keep their
numbers; ambiguous trailing numbers are now kept as separate books.

**Audible (5 minutes, action B2).** In Edge or Chrome, sign in at audible.com. In the app, open
**Settings → Import store purchases**, pick **Audible**, and follow the look-around steps shown
there. Paste the report into chat. It has no titles or account details; I need it to build the
Audible import.

## You can skip these

- **iCloud or OneDrive downloads:** you have neither on the PC, so there's nothing to test.
- **Calibre:** wait until you actually use Calibre.
- **Goodreads and StoryGraph:** you don't use them; someone who does can check those imports.

## What to send back

- Part 1: your yes/no for each of the 5 situations, plus anything you had to correct.
- Part 2: worked / didn't work / skipped for checks 1–29, and what happened for any that didn't
  work.
- **Settings → Diagnostics → Copy report** (it leaves out folder names unless you tick the box).
