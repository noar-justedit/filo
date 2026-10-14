# filo 0.8.2

Text for the GitHub Release **v0.8.2** (title: `filo 0.8.2`).

---

A two-panel FTP, FTPS and SFTP client for video professionals: large files,
moved as fast as the line allows, and verified on arrival.

**New in 0.8.2**

- **Nothing connects at launch** without you: every LIVE SYNC session starts
  disconnected, CONNECT starts it. Syncthing does not start before.
- A deleted or unplugged local folder is **never created again** by a session
  (it waits, with a clear error, and resumes when the folder is back).
- The queue says IDLE at launch, no more FINISHED from the old DONE list.

**New in 0.8.1**

- **The speed test works on a server whose root is read-only** (a NAS shows
  its shared folders at the root). If the bookmark points at the root, filo
  asks for a folder to test in. If the bookmark's folder refuses files, filo
  offers a reception-only test (it reads files already there and writes
  nothing) or CANCEL.

**New in 0.8.0**

- **Speed test of a bookmark**: the gauge icon measures the server sending
  and receiving, with 1, 2, 4 and 8 connections, and suggests the starting
  settings. SAVE keeps them with the date and the network; Auto starts from
  them on that network. A faster real transfer improves them.
- **You can see a connection being made**: the step it is on, a clock, and a
  CANCEL that really cuts it; a slow server is said to be slow.
- **A new header**: BOOKMARKS, FTP MODE and LIVE SYNC MODE in the title bar;
  the server on the right.

**New in 0.7.2**

- **LIVE SYNC bookmarks** in SITES: every session, one double-click away.
- **SESSION ID**: the MASTER sends it, the SLAVE pastes it and chooses its
  folder while it waits; the session opens by itself once the MASTER
  accepts. The invitation that sometimes never came is fixed.
- **The ring alone**: LIVE SYNC reduced to its ring in a small window, and
  filo in the menu bar / notification area on every system.
- A clear **DISCONNECT** button; the SYNCTHING queue empties as files
  arrive and says what is sent and what is received.
- **Nothing local is lost**: a download always goes to `.filopart` first,
  a file LIVE SYNC replaces goes to `.filo-trash`, damaged preferences are
  taken back from the copy saved at start.

**New in 0.7.1**

- **Shortcuts on the local side**: Desktop, Downloads and the disks mounted
  now, one click away, whatever the system and its language.

**New in 0.7.0**

- **A new layout**: a side bar on the left with TRANSFER, LIVE SYNC, SITES and
  SETTINGS, each an icon and its name; the view shown is in its colour. The
  connection bar is lighter: each field's name sits inside it.
- **Start the queue at a time** (right-click START): files added until then
  wait.
- **A command after the queue**: your own script, run when the queue
  finishes and before quit / sleep / shut down, with the folders, the result
  and the counts as arguments. No shell: a file name can never become a
  command.
- **Check against the other side** (right-click a folder): files already on
  both sides are compared by checksum, nothing is transferred.
- **Favorite folders** for each server: the star beside the server path.
- **Quick Look** on a local file with the Space bar (Mac).
- **LIVE SYNC**: the file moving now in the centre of the ring; the SYNCTHING
  queue can be paused; it now moves from the top on both computers (files go
  in name order); a phone alert (ntfy) when a session has been down for a
  while, and when it works again.
- The queue says FINISHED for a few seconds, then IDLE; the update notice
  looks like the one of the other Just Edit apps.

**Highlights**

- SFTP, FTPS (explicit and implicit) and plain FTP, passive or active.
- Parallel transfers, each on its own connection, with **Auto**: filo measures
  how many simultaneous transfers are fastest for each server.
- **Segmented SFTP transfers**: a large file travels over several connections
  at once.
- **Checksums** after every file, by the server when it can, otherwise by
  reading the file back. Files are written as `.filopart` until verified.
- Reliable **resume**, pause, stop and retry, per file or for the whole queue.
- Site manager with folders, FileZilla `sitemanager.xml` import and export;
  passwords in the system keychain.
- Phone notification (ntfy), your own command, and quit / sleep / shut down when the queue is done.
- LIVE SYNC with another filo (peer to peer, Syncthing inside), with a server, or both (DUAL SYNC).

**Downloads**

| System | File |
|---|---|
| macOS, Apple Silicon | `filo-0.8.2-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.8.2.exe` |
| Windows x64, portable | `filo-0.8.2-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.8.2_amd64.deb` |
| Linux x64, any distribution | `filo-0.8.2-linux-x86_64.AppImage` |

**Notes**

- Windows: the build is not signed. SmartScreen asks once: *More info → Run
  anyway*.
- Linux: `sudo apt install ./filo_0.8.2_amd64.deb`. The AppImage needs FUSE 2
  (`sudo apt install libfuse2t64`). On Ubuntu 24.04 and later, prefer the
  `.deb`: it installs the AppArmor profile Electron's sandbox needs.
- Server passwords on Linux need a desktop keyring (GNOME Keyring or KWallet).

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.8.2`. The build downloads Syncthing once (internet needed): the build log says "SYNCTHING: included".
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.8.2` on `main`, title
   `filo 0.8.2`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.8.2.
