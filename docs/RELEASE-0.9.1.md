# filo 0.9.1

Text for the GitHub Release **v0.9.1** (title: `filo 0.9.1`).

---

**New in 0.9.1**

- **Phone notifications on / off in one click**: a bell left of the settings
  (green: on, crossed out: off).
- **The speed graph stays inside the LIVE SYNC ring**, in the main view and in
  the small ring window.
- **LIVE SYNC with a server (S-FTP, DUAL SYNC) is steadier**: a sync and the
  relay of a large file no longer use the same connection at the same time,
  a relay is no longer cut by the idle close, a deleted session closes its
  connection, and a local folder that stops being watched is said in the LOG.
- **SYNCTHING never hands its key to another program** that took its port;
  it starts on another port instead.
- **Faster with very large queues and sessions**: removing thousands of
  files, long sessions, saving a big session state and the encrypted export
  no longer slow down or freeze the window.
- Smaller fixes: server checksums of two files at once, a long folder listing
  in a session's folder picker, a timer left running on the LOG tab, a
  tooltip that repeated "Not connected".

**Downloads**

| System | File |
|---|---|
| macOS, Apple Silicon | `filo-0.9.1-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.9.1.exe` |
| Windows x64, portable | `filo-0.9.1-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.9.1_amd64.deb` |
| Linux x64, any distribution | `filo-0.9.1-linux-x86_64.AppImage` |

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.9.1`.
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.9.1` on `main`, title
   `filo 0.9.1`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.9.1.
