# filo 0.9.0

Text for the GitHub Release **v0.9.0** (title: `filo 0.9.0`).

---

**New in 0.9.0**

- **Export your bookmarks with their passwords, encrypted.** EXPORT → "With
  passwords, encrypted…" asks for a passphrase (twice, 10 characters minimum).
  The passwords inside the file are locked with it; the bookmarks stay
  readable. At import, filo asks for the passphrase again. If someone edits a
  host in the file afterwards, filo refuses it. filo does not keep the
  passphrase: lose it and the passwords are gone.
- **Select several bookmarks, like in the Finder**: ⌘+click (Ctrl+click on
  Windows and Linux) adds or removes one, Shift+click selects a range. Then
  duplicate or delete them. Deleting asks first and says how many go.
- **A duplicated bookmark lands right under the original**, not at the end of
  the list.
- **FileZilla export is gone**: filo still imports FileZilla's
  `sitemanager.xml`, and exports its own file.

**Downloads**

| System | File |
|---|---|
| macOS, Apple Silicon | `filo-0.9.0-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.9.0.exe` |
| Windows x64, portable | `filo-0.9.0-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.9.0_amd64.deb` |
| Linux x64, any distribution | `filo-0.9.0-linux-x86_64.AppImage` |

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.9.0`.
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.9.0` on `main`, title
   `filo 0.9.0`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.9.0.
