# filo 0.9.2

Text for the GitHub Release **v0.9.2** (title: `filo 0.9.2`).

---

**New in 0.9.2**

- **Resuming an upload sent in segments no longer leaves holes in the file**
  on the server. It happened with filo's built-in engine (a build without the
  Rust engine) when a segment was cut half-way, and only CHECKSUM caught it.
  A segment now resumes exactly after what the server confirmed.

**Downloads**

| System | File |
|---|---|
| macOS, Apple Silicon | `filo-0.9.2-mac-arm64.dmg` |
| Windows x64, installer | `filo-Setup-0.9.2.exe` |
| Windows x64, portable | `filo-0.9.2-win-x64.zip` |
| Linux x64, Debian / Ubuntu | `filo_0.9.2_amd64.deb` |
| Linux x64, any distribution | `filo-0.9.2-linux-x86_64.AppImage` |

Full list of changes: [CHANGELOG.md](https://github.com/noar-justedit/filo/blob/main/CHANGELOG.md).

---

## Checklist before publishing (maintainer)

1. Builds: `build_mac.command` (dmg), `build_windows.command` or
   `build_on_windows.bat` (exe + zip), `./build_linux.sh` on Linux (deb +
   AppImage). Five files, all named `0.9.2`.
2. Try each one once: it opens, connects, transfers.
3. `scripts/push_github.command`: the code goes to GitHub, `version.json` waits.
4. On GitHub: *Releases → Draft a new release*, tag `v0.9.2` on `main`, title
   `filo 0.9.2`, the text above, the five files. Publish.
5. `scripts/push_github.command` again: `version.json` goes out, and installed
   copies of filo now announce 0.9.2.
