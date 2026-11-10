# Installing whatBooksNext on Windows

This guide assumes no programming experience. It takes about 10 minutes the first time.

**What you'll end up with:** a folder on your PC containing whatBooksNext, and a file you
double-click to start it. The app opens in your web browser, like a website, but it runs only on
your own PC. Nothing is uploaded anywhere, and it never changes your book files.

**What you need:**

- A Windows 10 or Windows 11 PC.
- An internet connection for the installation. After that, the app works offline.
- About 300 MB of free disk space.
- No account, sign-up or payment.

---

## Step 1 — Install Node.js (one time only)

whatBooksNext needs a free program called **Node.js** to run, in the same way some games need
DirectX. You install it once, and it then sits quietly in the background.

1. Go to **<https://nodejs.org>**.
2. Click the download button marked **LTS**. LTS means "long-term support", the stable version.
   Don't pick the one marked "Current".
3. If the site asks you to choose a file, pick the **Windows Installer (.msi)** for **x64**.
4. Open the downloaded file. It will be called something like `node-v24…-x64.msi`.
5. Click through the installer:
   - **Next**, tick **I accept**, **Next**, **Next**, **Next**.
   - On the screen called **Tools for Native Modules**, leave the box **unticked**.
     whatBooksNext doesn't need those tools.
   - Click **Install**. If Windows asks "Do you want to allow this app to make changes?",
     click **Yes**.
   - Click **Finish**.

> Already have Node.js? whatBooksNext needs version 24 or newer. The start file checks this
> for you and tells you if it's too old.

## Step 2 — Download whatBooksNext

1. On the whatBooksNext GitHub page, click the green **`<> Code`** button, then
   **Download ZIP**.
2. Find the ZIP file in your **Downloads** folder.

## Step 3 — Unzip it to a good place

Where you put the app matters a little. **Avoid:**

- your **Desktop** or **Documents** folder, if OneDrive backs them up. OneDrive tries to sync the
  thousands of small files the app installs, and that can make the installation fail;
- any folder that holds your books.

A good place is your **user folder** (`C:\Users\YourName`). To put it there:

1. Right-click the ZIP file and choose **Extract All…**.
2. In the box that shows where to extract to, replace the text with **`%USERPROFILE%`** and click
   **Extract**. `%USERPROFILE%` is Windows' shortcut for your user folder.
3. A window opens showing a new folder, called something like `WhatBooksNext-main`. You can
   rename it to **`whatBooksNext`** if you like (right-click → **Rename**).

## Step 4 — Start it

1. Open the `whatBooksNext` folder and double-click **`start-whatBooksNext.bat`**. If Windows
   hides file extensions, it shows as `start-whatBooksNext` with the type
   "Windows Batch File".
2. **If a blue window says "Windows protected your PC":** click **More info**, then
   **Run anyway**. Windows shows this for any file downloaded from the internet that isn't from a
   big software company.
3. A **black window** opens and shows its progress. **The first start takes 1–3 minutes** while it
   downloads the parts it needs. Later starts take a few seconds.
4. Your web browser then opens whatBooksNext. The address is **<http://localhost:4818>**.
   "localhost" means "this PC".

**Keep the black window open while you use the app.** You can minimise it. Closing it stops
whatBooksNext.

## Step 5 — Add your books

1. In **File Explorer**, find the folder where your books live (for example on your external
   drive).
2. **Right-click the folder** and choose **Copy as path**. On Windows 10, hold **Shift** while you
   right-click.
3. Back in whatBooksNext, paste the path into **Add a folder** (Ctrl+V) and click
   **Add and scan**.

A few thousand books take seconds to scan. Repeat this in **Settings** for any other folders.

Good to know:

- whatBooksNext **only reads the list of your files**. It never renames, moves or changes them.
- If your external drive isn't plugged in, those books stay in the library with the label
  "On external drive (not connected)", and nothing is lost.
- If you keep copies of a folder's books in **iCloud** to read on your iPhone or iPad, tick
  **Also in iCloud** on that folder in **Settings**.

---

## Everyday use

- **To start:** double-click `start-whatBooksNext.bat`. Double-clicking it while the app is
  already running just opens it in your browser again.
- **To stop:** close the black window.
- **Handy shortcuts:**
  - Bookmark <http://localhost:4818> in your browser. The bookmark only works while the black
    window is open.
  - For a desktop shortcut, right-click `start-whatBooksNext.bat` → **Show more options** (on
    Windows 11) → **Send to** → **Desktop (create shortcut)**.

## Trying it without your own books

Double-click **`start-demo.bat`**. It opens a **demo library** of invented books at
<http://localhost:4819>, marked "Demo library" at the top. It never touches your real library,
and it resets every time you start it. It can run at the same time as the real app.

## Back up your reading history

Everything you record (progress, ratings, notes, title fixes) is stored in the **`data`** folder
inside the whatBooksNext folder.

To keep a copy somewhere safe, go to **Settings → Download a backup**. You get one small file.
Keep it in your Documents or cloud storage. To restore it, use **Settings → Restore from a backup
file**. Restoring replaces everything in the app with the backup, after showing you what will
change.

## Updating to a new version

1. In the app, go to **Settings → Download a backup**, just in case.
2. Close the black window.
3. Download and unzip the new version as in Steps 2 and 3, into a **new** folder.
4. **Copy the `data` folder** from your old whatBooksNext folder into the new one. This carries
   over your library and reading history.
5. Double-click `start-whatBooksNext.bat` in the new folder. The first start after an update
   takes a minute again.
6. Once everything looks right, you can delete the old folder.

Before a new version changes its stored data, the app saves a safety copy automatically in
`data\snapshots`.

## Uninstalling

1. If you might want your reading history later, download a backup first (see above).
2. Delete the whatBooksNext folder. Nothing else was installed except Node.js.
3. To remove Node.js too: **Settings → Apps → Installed apps → Node.js → Uninstall**.

---

## If something goes wrong

The black window always says what went wrong. Find the message below.

**"Node.js is not installed, or Windows can't find it yet"**

- If you haven't installed it yet, do Step 1.
- If you have just installed it, close the black window and double-click the start file again.
  If that doesn't help, restart the PC. Windows sometimes only notices new programs after a
  restart.

**"needs Node.js 24 or newer"**

- Install the current **LTS** version from <https://nodejs.org> (Step 1). It replaces the old one.

**"Installing dependencies failed", with "EPERM" or "operation not permitted" above it**

- Another program is using some of the app's files. This is usually OneDrive, antivirus software
  or an open File Explorer window.
- To fix it:
  1. Close the black window.
  2. Delete the folder called **`node_modules`** inside the whatBooksNext folder.
  3. Start again.
- If it keeps happening, move the whole whatBooksNext folder out of your Desktop or Documents, as
  in Step 3.

**"Installing dependencies failed", with a network error above it**

- Check your internet connection and start again. Only the first start, and the first start after
  an update, needs the internet.

**"Port 4818 is used by another program"**

- Another program on your PC is using the address whatBooksNext wants. You can start
  whatBooksNext on a different one:
  1. Open the whatBooksNext folder in File Explorer.
  2. Click the address bar at the top, type `cmd` and press Enter. A black window opens.
  3. Type this and press Enter:

     ```bat
     set PORT=4820
     ```

  4. Then type this and press Enter:

     ```bat
     start-whatBooksNext.bat
     ```

  5. The app then runs at <http://localhost:4820>.

**The browser didn't open by itself**

- Open your browser and go to <http://localhost:4818>.

**The browser says "This site can't be reached"**

- whatBooksNext isn't running, because the black window was closed. Double-click the start file
  again.

**"The database couldn't be updated"**

- Nothing was changed, and your data is safe. The message names the safety copy that was saved
  (in `data\snapshots`, called `pre-migration-…`).
- To go back to the version that worked:
  1. Close the black window.
  2. In the `data` folder, rename `whatbooksnext.sqlite` to `whatbooksnext-broken.sqlite`, and
     delete `whatbooksnext.sqlite-wal` and `whatbooksnext.sqlite-shm` if they are there.
  3. Copy the safety copy the message named into the `data` folder and rename it
     `whatbooksnext.sqlite`.
  4. Start the **previous** version of whatBooksNext (the old folder, if you kept it).
- Then copy the whole message and ask for help.

**Going back to a full snapshot**

- If you took one (Settings → Export and snapshots), its folder in `data\full-snapshots` has a
  `README.txt` with the steps. API keys aren't in it: enter them again in Settings afterwards.

**Anything else**

- In the app, open **Diagnostics** and click **Copy report**. Share that together with the text
  from the black window. The report doesn't include your folder or book names unless you tick
  the box.
