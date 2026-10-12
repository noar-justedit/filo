# filo — command line

Another program (an export preset, a script, ingesto, presto…) can ask filo to
send, fetch or run a LIVE SYNC. The files go through the queue of the filo
that is open, and show in its window, like files dropped by hand.

```
filo upload   --site <site> --to <server folder>  <local file or folder>…
filo download --site <site> --to <local folder>   <server file or folder>…
filo livesync --pair <live sync>
filo queue    start | pause | stop
filo status
filo help | version
```

In filo, **Settings → POST COMMAND** shows the exact command for this computer
(COPY), and the **(i)** button lists these commands with examples to copy.

## Where the `filo` command is

| | |
|---|---|
| **macOS** | Settings → POST COMMAND → **INSTALL** (or the *filo* menu → *Install the command line tool…*). macOS asks for the Mac's password once; then `filo` works in the Terminal. Without it: `/Applications/filo.app/Contents/MacOS/filo` |
| **Linux (.deb)** | `filo` is installed with the package |
| **Linux (AppImage)** | the AppImage file itself: `~/Applications/filo-x.y.z-linux-x86_64.AppImage upload …` |
| **Windows** | `"%LOCALAPPDATA%\Programs\filo\filo.exe"` (or where it was installed). See *Windows* below |

## Options

| | |
|---|---|
| `--site <site>` | a site of the site manager, by name (case does not matter) or by id |
| `--pair <live sync>` | a live sync of the LIVE SYNC window, by name or id |
| `--to <folder>` | where the files go: a server folder for `upload`, a local folder for `download` |
| `--wait` | wait until the files are done; the exit code tells how it went |
| `--json` | one JSON line per event, for programs |
| `--out <file>` | also write the final result, as JSON, to this file |
| `--background` | when filo has to be started, start it minimised |

Folders are sent with everything they contain. Local paths are taken from the
folder the command is started in.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done (with `--wait`: every file arrived and was verified) |
| 1 | some files failed or were stopped |
| 2 | the command is not right (missing option, file not found) |
| 3 | the site or the live sync does not exist, or the server refused the account (the queue is then stopped, waiting for someone at the window) |
| 4 | filo could not be started or reached |

## Examples

```sh
# A card, straight to the NAS, and wait for the checksums
filo upload --site "Studio NAS" --to /Rushes/Day2 --wait /Volumes/CARD_A/A001

# A delivery, fetched into the project
filo download --site "Client SFTP" --to ~/Projects/Doha /Delivery/Final_v3.mov

# The end of an export: run the live sync now and wait
filo livesync --pair "Exports → client" --wait
```

With `livesync --wait`, a file that is still being written (or seen for the first
time) is looked at again every few seconds until it is stable, then sent:
`--wait` covers everything that is in the folder when the command starts.

For a SYNCTHING live sync (another filo, no server), `livesync` asks for the
folder to be checked now; the other filo receives the changes while both are
open. `--wait` does not wait for it.

## For programs: `--json`

Each line is one JSON object. The last one has `"type": "result"`.

```json
{"type":"queued","files":3,"conflict":0,"message":"3 files in the queue (Studio NAS)"}
{"type":"progress","files":3,"finished":1,"bytes":1100000,"total":3300000,"message":"1/3 files · 33 %"}
{"type":"result","code":0,"files":3,"done":3,"skipped":0,"failed":0,"errors":[],"message":"3 files done"}
```

On failure, `errors` lists the files and why (at most 50), and `error` says
what stopped the command.

## Security

- **No password ever goes on the command line.** Commands use the sites of the
  site manager, with their saved password (in the system keychain) or key.
- The command talks only to the filo of the **same user on the same computer**:
  a Unix socket in filo's profile folder, readable by this user only (macOS,
  Linux), or a named pipe (Windows), plus a random token re-made at each start
  of filo and kept in the profile folder (readable by this user only).
- Nothing listens on the network.

## Windows

`filo.exe` is a windowed program. Started from a program (a script in Python
or Node, an export preset), its output and exit code arrive normally. Typed in
a Command Prompt window, Windows does not wait for it: the prompt comes back
at once and `%ERRORLEVEL%` is not its code. In a `.bat` or `.cmd` file,
Windows does wait.

`filo sync` (its earlier name) still works and does the same as
`filo livesync`.

## Limits

- One filo at a time per user: commands go to the open one (started if needed).
- `queue pause | stop` acts on the whole queue, files added by hand included.
- A server that refuses the account stops the whole queue (as in the window):
  a waiting command then ends with code 3.
