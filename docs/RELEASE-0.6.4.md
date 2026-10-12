# filo 0.6.4

Text for the GitHub Release **v0.6.4** (title: `filo 0.6.4`).

---

A two-panel FTP, FTPS and SFTP client for video professionals: large files,
moved as fast as the line allows, and verified on arrival.

**New in 0.6.4**

- **Site Manager**: opens as you left it; right-click menus for new sites
  and folders, rename, duplicate and delete; a NEW FOLDER button; empty
  folders stay; a clear drop line when you arrange sites by dragging, and the
  empty space takes them back to the top level.

- **Synchronized browsing shows the differences**: with FileZilla's two
  colours, the names of what is only on one side are highlighted in yellow,
  what is newer on one side in green. A count under each panel, and a filter
  button to show only what differs.

- **LIVE SYNC with another filo, peer to peer** (mode SYNCTHING): two
  computers keep a folder in step directly, with no server in between, on the
  same network or across the internet. It uses Syncthing (MPL-2.0), shipped
  inside filo.
- **DUAL SYNC**: SYNCTHING first (the fastest way); once both computers are
  up to date, the MASTER keeps a folder on an FTP, FTPS or SFTP server in step
  with its own (S-FTP BACKUP), both ways: what is put there by hand reaches
  both computers. While the other computer cannot be reached, the files go
  through that server.
- **MASTER and SLAVE**: the computer that creates a session is its MASTER. Its
  version wins a conflict (the other one is kept beside it), its direction and
  its file filter are the session's. The MASTER sends, the SLAVE imports: a
  config file, or, for a SYNCTHING session, the MASTER's SYNCTHING ID.
- **Nothing lost**: a file deleted on one computer goes into the other one's
  trash (`.filo-trash`, never synced, never emptied by filo).
- **A new LIVE SYNC view**: this computer on the left, the other side on the
  right, a ring in the centre with the progress, the speed, what is left, and
  arrows showing which way files are moving.
- **MODE** in the connection bar switches between the FTP client and the
  LIVE SYNC view. The ring says **UP TO DATE** when both computers are in
  step, **ALL UP TO DATE** when the S-FTP BACKUP is too. Smooth speed graphs,
  a clearer queue header with a progress bar, each mode in its own colour, and
  a turquoise logo.
- Two code reviews before release: security (the S-FTP BACKUP never deletes
  what this session does not know, server names can never leave the synced folder),
  reliability of the server route, and the interface (one badge design, one
  colour per mode, one name per thing).
- `THIRD_PARTY_NOTICES.md`: every component inside filo, with its licence.

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
- Phone notification (ntfy) and quit / sleep / shut down when the queue is done.

**Downloads**

| System | File |
|---|---|
| macOS, Apple Silicon | `filo-0.6.4-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.6.4.exe` |
| Windows x64, portable | `filo-0.6.4-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.6.4_amd64.deb` |
| Linux x64, any distribution | `filo-0.6.4-linux-x86_64.AppImage` |

**Notes**

- Windows: the build is not signed. SmartScreen asks once: *More info → Run
  anyway*.
- Linux: `sudo apt install ./filo_0.6.4_amd64.deb`. The AppImage needs FUSE 2
  (`sudo apt install libfuse2t64`). On Ubuntu 24.04 and later, prefer the
  `.deb`: it installs the AppArmor profile Electron's sandbox needs.
- Server passwords on Linux need a desktop keyring (GNOME Keyring or KWallet).

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.6.4`. The build downloads Syncthing once (internet needed): the build log says "SYNCTHING: included".
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.6.4` on `main`, title
   `filo 0.6.4`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.6.4.
