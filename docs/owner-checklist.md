# Owner checklist: quality session and Windows checks

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

## You can skip these

- **iCloud or OneDrive downloads:** you have neither on the PC, so there's nothing to test.
- **Calibre:** wait until you actually use Calibre.
- **Goodreads and StoryGraph:** you don't use them; someone who does can check those imports.

## What to send back

- Part 1: your yes/no for each of the 5 situations, plus anything you had to correct.
- Part 2: worked / didn't work / skipped for checks 1–13, and what happened for any that didn't
  work.
- **Settings → Diagnostics → Copy report** (it leaves out folder names unless you tick the box).
