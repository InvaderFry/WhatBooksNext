# whatBooksNext Windows probe (Milestone 0)

A read-only check of your library folders on Windows. It answers the questions the app
depends on before any of the app is built:

- Can drives be told apart when their letters change?
- Do online-only iCloud files show up in their attributes, as the plan assumes? And does
  reading those attributes leave them online-only?
- How many copies of the same file sit in several places, and how many books come as
  EPUB + PDF (+ MOBI, + HD) sets?
- What do the filenames look like?

You don't need any AI or other software to run it. The report is plain English.

## What it does and doesn't do

It **does**:

- list the folders you name, reading only each file's **name, size, dates and
  attributes** from the directory listing;
- read drive details (letter, label, volume id, serial, drive and bus type);
- read only the **attributes** of 2–3 online-only files you name, wait 10 seconds and
  check them again;
- write **one** text file: `whatbooks-probe-report-<date>-<time>.txt` next to the script.
  If the script is inside one of your library folders, the report goes on your Desktop
  instead, and if that's also inside one, the report is shown on screen and not saved.

It **never**:

- opens, reads, copies, moves, renames or changes your files, or creates anything in your
  library folders;
- reads the contents of an online-only file, so it can't trigger an iCloud download.
  (Listing a cloud folder the PC hasn't listed before can make iCloud fetch that folder's
  *list of names*. That's normal, and no file contents are downloaded.);
- follows junctions or symbolic links, so a folder that loops back on itself can't trap it;
- sends anything anywhere.

It runs PowerShell with `-NoProfile -ExecutionPolicy Bypass` for this script only. That
changes no setting on your PC. The PowerShell code is plain text at the bottom of the
`.bat` file, so you can read it first.

## How to run it

1. Download `whatbooks-probe.bat` and put it somewhere outside your library folders, such
   as your Downloads folder.
2. **Plug in your external drive**, so it can be checked too.
3. Double-click `whatbooks-probe.bat`. If Windows SmartScreen warns about an unknown file,
   choose **More info → Run anyway**.
4. Answer the four steps:
   1. **Folders:** paste or drag in each library folder (external drive, iCloud Drive,
      anywhere else), then press Enter on an empty line.
   2. Wait while it lists the files. A few thousand files take seconds.
   3. **Online-only files:** in File Explorer, find 2–3 books with a **cloud icon** (not a
      green tick). Shift + right-click one, choose **Copy as path**, and paste it in. Repeat,
      then press Enter.
   4. **Filename sample:** choose whether to add up to 300 random book filenames (names
      only, no folders). They help test the filename parser.
5. The report opens in Notepad. Read it, delete anything you want to keep private, and
   paste it into the chat.

## Privacy

Apart from the optional filename sample, the report has **no file or folder names**:
only counts, attribute numbers and drive details. Neither the report nor your filenames
are ever committed to this public repository. `.gitignore` excludes the report files, and
real filenames go in the git-ignored `fixtures/private/` folder.

## If something goes wrong

- **The window closes immediately or says "Could not find the PowerShell part":** the file
  was probably saved with altered line endings. Download it again with the raw-file button
  rather than copying and pasting the text.
- **Antivirus blocks it:** it runs PowerShell code stored inside the `.bat`, which some
  antivirus tools are wary of. You can read the code at the bottom of the file. If you're
  happy with it, allow it, or say so in the chat and we'll find another way.
- **"Not available" next to drive details:** some details need features that not every
  Windows edition has. The report still works, so share it as it is.
