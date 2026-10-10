# Changelog

All notable changes to filo are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

## [0.3.4] — 2026-10-10

The first public release. Noar's interface requests, then a full code review
before going to GitHub.

### Changed

- **Rename in place**, as in the Finder and Explorer: the name becomes an
  editable field on its own row instead of a separate window. F2, *Rename* in
  the menu, or a slow second click on the name of the selected row. For a
  file, only the part before the extension is selected. Enter or a click
  elsewhere renames; Escape cancels. A refused name (an error from the server
  or the disk) puts the field back with what was typed.
- **CONNECT / DISCONNECT** in one button, first in the bar: green CONNECT,
  red DISCONNECT once connected. Typing another server in the bar turns it
  back into CONNECT (the new connection replaces the current one). The
  separate disconnect icon of the title bar is gone.
- **Protocol**: only the one in use is shown; a click lists the four.
- **When the queue finishes** button moved from the title bar to the bar,
  right of synchronised browsing.
- **Recent connections** (was "recent quick connections") lists sites too: a
  site connects straight away, a quick connection fills the bar.
- **Title bar**: a site shows its name and its address (user@host:port); a
  click copies the address.
- **Settings in four groups** (Transfers, File management, Verification,
  Notifications) plus Known servers. Parallel transfers and the Auto maximum
  on one line; both speed limits on one line, empty = no limit. One
  verification switch: server checksum (a server that cannot is read back),
  or read every file back. The older "never read back" choice is gone.
- **ntfy**: two separate QR codes, to the Android (Google Play) and iPhone
  (App Store) apps.
- **Known servers**: sorted by address, counted, in a box of their own that
  scrolls, with a search once there are more than six.
- Enter in the connection bar never disconnects, and does nothing while a
  connection is being made; Escape puts the bar back on the server in use.
  The recent connections menu has *Disconnect*.
- Renaming in place: a name Windows refuses (`\ : * ? " < > |`, reserved
  names) is said plainly instead of being changed quietly; changing only the
  case of a name works; switching to another application while typing no
  longer applies the rename; a slow click no longer opens the field late.
- The title bar says what verification will really do, from the server and
  the settings. FTPS implicit is "FTPS-i" everywhere it is short.

- **Publishing from Windows**: `scripts/push_github.bat` does what
  `push_github.command` does on a Mac (Git for Windows needed).
- README: new screenshots (main window, site manager, settings).

### Security

- **FTPS in active mode**: the data connection must resume the checked TLS
  session or show the server's certificate, as in passive mode (it was not
  checked).
- **Browsing actions stay on their server**: a delete or a folder listing in
  progress stops if the panel connects to another server, instead of
  carrying on over there. Several actions failing at once share one
  reconnection.
- **A pasted address filo cannot read** (a password with "@" or "/" in it)
  is refused before anything is logged: no password in the log.
- **A wrong password typed for a connection is forgotten** when the server
  refuses the login: the next attempt asks again (or uses the saved one).

### Fixed

- **No file replaced without the user's rule**:
  - a file that appears under the real name while a transfer runs (another
    program, or another connection of filo whose listing was a minute old)
    goes through the "already there" rule at the end;
  - two different files for one destination (two cards with the same clip
    names into one folder) are no longer both queued: the second is left out
    and said;
  - START AGAIN no longer overwrites a file filo did not write: the rule
    applies.
- **Resume**: a segment that fails while connecting keeps what it already
  holds (it was sent again, and progress could pass 100 %); a stopped file
  keeps its progress across a relaunch, so START AGAIN and the question
  still apply; a retry while the file's connections are still ending waits
  for them.
- Auto: a connection limit learned from one server no longer caps the next
  runs. A short retry no longer waits behind a long one.
- Deleted sites leave the recent connections; a damaged recent list no
  longer blocks connecting. Cancel stops every delete in progress.

## [0.3.3] — 2026-10-09

Never published.

### Added

- **Lasso selection** in both panels: press in the empty space below the
  list and drag; every row the rectangle crosses is selected (⌘ / Ctrl or
  Shift: added to the selection). The list scrolls when the pointer passes its
  top or bottom edge. Dragging files still starts from a file's row.
- **"Apply to: this file only / the whole queue"**, as in FileZilla, in the
  two questions a transfer can ask. *Resume or start again?* can also apply
  the answer to every other stopped file of the queue that has a partial copy
  (they start again with it). *Already there* applies the choice to every
  other upload (or download) of the queue.

### Changed

- **Auto starts higher for a file in segments**: 4 connections at once
  instead of 2, then measures and climbs (or comes back) as before. Measured
  on one 400 MB download at 80 ms: 56 MB/s instead of 43 MB/s, the same as
  the best fixed setting.

### Security

- **basic-ftp 6.2.3** (was 5): fixes a published flaw of version 5
  (`npm audit` now reports nothing). Version 6 refuses outright a passive
  reply that names another address than the server's, which breaks servers
  behind a NAT router announcing their private address. filo now opens the
  passive data connection itself: EPSV first, then PASV, keeping only the
  port and always connecting to the server's own address, as FileZilla does.
  NAT-proof, and a server still cannot send the data connection elsewhere.

## [0.3.2] — 2026-10-09

Noar's second round of tests. Never published.

### Changed

- **Windows (and every) build much faster**: `compression: normal` instead of
  `maximum`. Measured on the Windows zip: 91 s instead of 618 s, for a file
  0.3 % bigger (147.2 MB instead of 147.0 MB).
- **Bars and rings are precise**: they move with every byte instead of
  jumping a whole percent at a time. The percentages stay whole numbers.
- **Instant speed and peak** written over the speed graph.
- **Column widths** (NAME, SIZE, MODIFIED) adjustable by dragging the column
  borders in both panels; double-click a border for the default widths. Kept
  per panel.
- After a stop or a pause, the destination panel is refreshed: the local side
  for a download, the server side for an upload.
- **Segments sized for speed**: files of 64 MB and more are split, into
  about 16 segments of 32 to 256 MB (before: 256 MB segments, from 512 MB
  only, so a 1 GB file used at most 4 connections). Measured at 80 ms round
  trip with 8 connections, 400 MB file: upload 12 → 47 MB/s, download 56 →
  65 MB/s.
- **Piece bar** for files sent in segments: filo's thin bar, drawn the way
  qBittorrent draws a torrent's pieces — every segment at its place in the
  file, filled as far as it is in place (green done, bright green on its way,
  pale green kept after a cut, orange waiting to be tried again).

### Fixed

- **A large file cut before the end of its first segments started again from
  zero** (and its progress fell back to 0 %): a segment cut half-way now keeps
  what it already received (exactly, for a download; minus 6 MB for an upload,
  whose last writes may land in any order) and resumes from there.
- Folders of the site manager that held the selected site could not be
  folded: they were forced open. They are now opened once, when the site is
  chosen, and fold like any other.

## [0.3.1] — 2026-10-09

Noar's first round of tests on 0.3.0. Never published.

### Added

- **Site manager: drag and drop.** Sites and folders are arranged by hand:
  drop a site before or after another, or onto a folder; drop a folder before,
  after or into another; drop below the list to bring it to the top level.
  The order is kept. Sites are no longer sorted A to Z.
- **Retry asks "Resume or start again?"** when the file had already started
  (row button, menu, Retry all). Start again sends the whole file once more.
- **Hidden files button** (eye) in both panels, next to "new folder": hides
  or shows names starting with a dot and the files Windows and macOS leave on
  disks (Thumbs.db, desktop.ini, $RECYCLE.BIN, System Volume Information,
  ._ files, Icon…). Same switch as the menu and Settings.
- **Speed graph** behind the queue title: the total speed over the last
  minute, as in syncto and ingesto.

### Fixed

- The STOP and PAUSE buttons of a running row did nothing: the row was redrawn
  several times a second, between the press and the release of the click. The
  moving figures are now updated in place.
- Double-clicking a site in the site manager connects again (the first click
  redrew the list, so the double-click was lost).
- **Adding a file again after stopping it started it again from zero, without
  a word**, over its partial copy. The stopped item now comes back with what
  it had transferred, and filo asks "Resume or start again?". A file still
  waiting, running or paused is not added twice (two items would have written
  the same partial file at once).

## [0.3.0] — 2026-10-09

Linux, and ready for GitHub. Never published.

### Added

- **Linux packages**, built on Linux: `./build_linux.sh` (or `./build.sh` on a
  Linux machine) writes a `.deb` and an AppImage (x64). Tried on Ubuntu 24.04:
  the `.deb` installs (menu entry, icon, `filo` command, AppArmor profile for
  Ubuntu 24.04+), and both open, connect and transfer.
- `SECURITY.md`, `CONTRIBUTING.md`, a Download section in the README and the
  text of the GitHub Release (`docs/RELEASE-<version>.md`).

### Changed

- Linux wording: "Move to Trash" and "Show in file manager" (it said Recycle
  Bin and Explorer).
- Linux: the window and the task bar show filo's icon even for an AppImage
  started from a folder.
- The `.deb` is filed under Network / File transfer (menu) and `net` (Debian
  section), and no longer recommends a tray library filo does not use.
- electron-builder never publishes anything and no longer writes unused
  update files (`latest-*.yml`): Releases are made by hand.
- `.gitignore` keeps signing certificates, `.env` files and logs out of the
  repository.

## [0.2.0] — 2026-10-09

Interface adjustments and a code review (security, interface, bugs).

### Changed

- Queue rows: the percentage, in green, takes the place of the small ring; the
  general ring stays. CHECKSUM and CONNECTIONS lose their dark background.
  Synchronized browsing is an icon. The protocol buttons never shrink (FTPS-i
  was cut off in a narrow window).
- Keyboard shortcuts in tooltips read Ctrl on Windows and Linux.
- Clearing the Failed list, and removing unfinished files from the queue,
  ask first: their partial files are deleted.
- Select all (Ctrl/⌘A) in the queue selects every row of the tab.
- Downloads write to disk in large blocks: everything received while the
  previous write is on its way goes out at once. Much faster to a network
  drive (SMB share, NAS, a virtual machine's shared folder); no visible change
  on a local disk. Up to 8 MB of memory per connection.

### Security

- FTP: the data connection always goes to the server's own address, whatever
  a passive-mode reply says (no more bounce to another host).
- FTPS: every data connection must resume the checked TLS session or show the
  very same certificate; otherwise it is refused.
- FTP active mode refuses every incoming connection when the server's address
  is unknown.
- SFTP downloads: the read-ahead is bounded (a server can no longer make the
  waiting pieces fill the memory), and one minute without any reply ends the
  transfer as a network error instead of hanging for ever.
- SFTP server checksums: names with a quote, a backslash or a control
  character are verified by reading back instead of through a shell command;
  a timed-out command is closed on the server.
- A server identity can only be trusted from the queue banner if filo showed
  it; a changed identity is never replaced from there.
- The end action (quit, sleep, shut down) is decided by the main process: the
  last run really finished cleanly and nothing has started since.
- The window gets no device permissions; `--dev` does nothing in a shipped
  build.
- Electron fuses in every build: the filo executable can no longer be started
  as a plain Node.js (`ELECTRON_RUN_AS_NODE`), with a debugger (`--inspect`) or
  with `NODE_OPTIONS`, and only loads its own, integrity-checked `app.asar`.
- FileZilla import: a broken character number or absurdly deep folders no
  longer stop the import. More Windows reserved names handled.

### Fixed

- A resumed SFTP upload starts 2 MB before the end of the partial file: a cut
  can leave the end written while a piece before it is not.
- A partial file that filo itself left under the real name (temporary names
  off, or "resume") is completed on the next attempt, never skipped as
  "already there" nor asked about.
- A server refusing one more connection no longer causes an immediate
  reconnection loop with a fixed number of connections.
- A file removed while it ran could stay in the queue for ever and keep the
  queue from finishing.
- "Already there" questions: closed when their file is paused, stopped or
  removed; a late answer no longer revives a finished file; Escape no longer
  answers "skip"; a window arriving while another is open waits its turn
  instead of answering it.
- Pause or Stop all during a folder listing no longer restarts the queue.
- A file retried during the run no longer counts as failed in the summary.
- The end-of-queue countdown cannot run twice, and stops if a transfer starts.
- The server panel refreshes again while uploads land.
- The queue list could show another tab's rows after a quick tab change;
  shift-click could fail after filtering; "Retry in N s" now counts down;
  UPLOAD becomes available right after connecting; File › Export sites opens
  its menu in place; Start the queue (menu) resumes files paused one by one;
  a password being typed in the site manager stays visible when the form
  changes; the Clear button is disabled on an empty tab; a queue added
  without starting reads QUEUE, not PAUSED; the waiting banner goes when
  nothing is left to do.

## [0.1.0] — 2026-10-09

First version.

### Added

- **Protocols**: SFTP, FTPS explicit, FTPS implicit, plain FTP (marked *not
  encrypted* wherever it shows). FTP in passive mode by default, active mode per
  site (PORT / EPRT, TLS on the data connection included).
- **Two panels**, local and server (a Browse button left of the local path;
  on Windows, *This PC* above every drive root): sorting, filter, hidden files, type-ahead,
  keyboard navigation, rename, new folder, delete (local: to the Trash; server:
  confirmed, recursive), drag and drop between the panels and from the Finder /
  Explorer, double-click to transfer. Server listings are kept, so going back to
  a folder is instant.
- **Quick connect** bar, accepting a pasted `sftp://user@host:port/path`, with a
  history of recent connections (never a password).
- **Synchronized browsing**: opening a folder on one side opens the folder of
  the same name on the other side; going up goes up on both.
- **Site manager**: folders shown as a tree that folds and unfolds, notes, login folders, per-site connection limit,
  FTP transfer mode, key files; duplicate; import and export as filo JSON or
  FileZilla `sitemanager.xml` (passwords never exported; FileZilla passwords can
  be imported into the keychain).
- **Queue**: parallel transfers on separate connections, each in its own thread;
  saved continuously and restored at launch; Pause keeps partial files and Start
  resumes them; retries with increasing delays on network errors; Queue, Failed,
  Done and Log tabs, with speed, data left and time left as badges.
- **Per-file controls**: pause / resume, stop and retry on every row, and in
  the right-click menu; play / pause and stop for the whole queue.
- **Connections** control: Auto or 1 to 10 files at the same time, from the
  queue.
- **Auto simultaneous transfers**: measures throughput in MB/s and files/s and
  climbs one connection at a time while it pays, holds the best level, tries
  again later; learns and respects a server's connection limit.
- **Segmented transfers (SFTP)**: files of 512 MB and more are cut into 256 MB
  segments carried by several connections at once; finished segments survive a
  pause, a crash or a cut.
- **Adaptive SFTP read depth and receive window**: one download is no longer
  capped at 2 MB per round trip on long-distance links.
- **Resume** of any interrupted file, checked against the source's size and date.
- **Checksums**, switchable from the queue: computed by the server when it can
  (FTP `HASH` / `XSHA256`…, `sha256sum` over SSH), otherwise by reading back
  (xxHash64); per segment for segmented files. Native SHA-256 / SHA-1 / MD5.
- **Temporary names**: `.filopart` until complete and verified.
- **File already there**: ask (with "the same for every other file"),
  overwrite, overwrite if newer, if the size differs, resume, keep both, skip.
- **Server identity**: SSH host keys and FTPS certificates shown with their
  fingerprint on first contact, pinned, a change refused; list and forget them
  in the settings.
- **FTP listings**: the server's time zone is measured once (MDTM) and listing
  dates corrected.
- **Speed limits** per direction.
- **When the queue finishes**: phone notification (ntfy), then quit, sleep or
  shut down after a 30 s countdown — only if nothing failed.
- Passwords in the system keychain via Electron `safeStorage`.
- Build scripts for macOS (signed and notarized), Windows (from the Mac, or on
  a Windows PC with `build_on_windows.bat`) and Linux;
  `scripts/push_github.command` for publishing, including the very first
  publication to an empty repository.
