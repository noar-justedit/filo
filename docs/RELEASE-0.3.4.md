# filo 0.3.4

Text for the GitHub Release **v0.3.4** (title: `filo 0.3.4`). The first public
release: 0.1.0 to 0.3.3 were never published.

---

A two-panel FTP, FTPS and SFTP client for video professionals: large files,
moved as fast as the line allows, and verified on arrival.

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
| macOS, Apple Silicon | `filo-0.3.4-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.3.4.exe` |
| Windows x64, portable | `filo-0.3.4-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.3.4_amd64.deb` |
| Linux x64, any distribution | `filo-0.3.4-linux-x86_64.AppImage` |

**Notes**

- Windows: the build is not signed. SmartScreen asks once: *More info → Run
  anyway*.
- Linux: `sudo apt install ./filo_0.3.4_amd64.deb`. The AppImage needs FUSE 2
  (`sudo apt install libfuse2t64`). On Ubuntu 24.04 and later, prefer the
  `.deb`: it installs the AppArmor profile Electron's sandbox needs.
- Server passwords on Linux need a desktop keyring (GNOME Keyring or KWallet).

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.3.4`.
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.3.4` on `main`, title
   `filo 0.3.4`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.3.4.
