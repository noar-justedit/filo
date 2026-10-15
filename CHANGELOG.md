# Changelog

All notable changes to filo are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

## [0.9.0] — 2026-10-14

### Added

- **Export with passwords, encrypted** (Noar). EXPORT → "With passwords,
  encrypted…" asks for a passphrase (twice, 10 characters minimum) and writes
  a filo export whose passwords (and key passphrases) are locked with it
  (AES-256-GCM, key derived with scrypt). The sites stay readable. At import,
  filo asks for the passphrase again; a wrong one imports nothing. The block is
  tied to each site's protocol, host, port and user: a file whose hosts were
  edited afterwards is refused, so no password can be redirected to another
  server. filo does not keep the passphrase: lost, the passwords cannot be
  recovered. Not available on a machine without a usable keychain (no password
  is stored there to export).
- **Select several bookmarks, the Finder's way** (Noar). ⌘+click (Ctrl+click on
  Windows and Linux) adds or removes one, Shift+click selects the range over
  the rows shown. Right-click or the buttons on the right: DUPLICATE or
  DELETE. Deleting asks first and says how many sites go ("Delete 12
  sites?").

### Changed

- **A duplicated bookmark appears right under its source**, not at the end of
  the list (also for several at once: each copy under its own original).
- **FileZilla export removed** (Noar): filo imports FileZilla's
  `sitemanager.xml` but no longer writes it. The filo export (.json) stays.

## [0.8.2] — 2026-10-14

### Fixed

- **A folder TEST created in Downloads at launch** (Noar, Linux). A SYNCTHING
  session whose local folder had been deleted (or whose disk was unplugged)
  made Syncthing create it again, empty. Now filo checks the folder first: if
  it is missing, the session is paused with a clear error and nothing is
  created or deleted; it starts again by itself when the folder is back.
- **FINISHED shown at launch.** The DONE list kept from the last time filo was
  open made the queue say FINISHED with a full bar. FINISHED now only appears
  after a transfer run during this opening; at launch it says IDLE.

### Changed

- **Nothing connects at launch without the user** (Noar). Every LIVE SYNC
  session (S-FTP, SYNCTHING, DUAL SYNC and its S-FTP BACKUP) starts
  DISCONNECTED and CONNECT starts it. Syncthing itself does not start until a
  session is connected. A session connected stays so until filo is closed.

### Docs

- The 6 screenshots are retaken at every version (rule in AGENTS.md);
  `livesync.png` no longer shows an old version number.

## [0.8.1] — 2026-10-14

### Fixed

- **Speed test: "Permission denied" on a NAS** (Noar). The test wrote its
  temporary files at the login folder, which on a NAS is the server root and
  not writable. Now, a bookmark pointing at the root makes filo ask for a
  folder to test in (folder chooser). A bookmark with a folder is used as it
  is; only if that folder refuses a file, filo offers a **reception-only
  test** (reads files already there, writes nothing, sending is not measured)
  or CANCEL. Saving a reception-only result keeps the previous send figure
  when it was measured on the same network.

## [0.8.0] — 2026-10-13

### Added

- **Speed test of a bookmark** (Noar): the gauge icon on a bookmark measures
  the server, sending (OUT) and receiving (IN), with 1, 2, 4 and 8
  connections (as many as the server accepts) and, in SFTP, one big file in
  segments; 20 s or 60 s. Two gauges, one graph, then what it suggests: the
  starting number of connections (one more only if it buys 10 %) and whether
  segments help. The latency, the connections the server accepts and its
  checksums are shown live. SAVE keeps the figures in the bookmark with the
  date and the network they were measured on; **Auto starts from them**
  whenever filo is on that network (elsewhere it starts as usual), and a file
  is sent whole when segments gained nothing there. The test writes
  temporary files (`.filo-speedtest-…`) in the login folder and removes them
  at the end, also when cancelled or failed.
- A real transfer that goes **faster than the speed test** says updates the
  bookmark's figures for that direction (never lower ones); only a bookmark
  already tested, on the same network.
- **Connection in progress**: the title bar shows the server, the step
  (finding the address, opening the connection, secure handshake, login,
  reading the folder), a clock and CANCEL; an orange bar runs under the
  title bar; the server panel lists the steps. After 8 s on one step it says
  the server is slow to answer. CANCEL really cuts the connection.

### Changed

- **The three places are in the title bar**: BOOKMARKS (an icon), FTP MODE
  and LIVE SYNC MODE replace the side bar. The server (name, address,
  protocol) moves to the right, with Settings as an icon.
- SITES is now called **BOOKMARKS** everywhere.

## [0.7.2] — 2026-10-13

### Added

- **LIVE SYNC bookmarks** (Noar): in SITES, a LIVE SYNC folder, always
  first, lists every session (made from the sessions: renamed or deleted
  there, at once here). Double-click: the session in the LIVE SYNC view
  (connected first if it is off, asked). Right-click: open, browse its
  S-FTP folder, session settings.
- **SESSION ID**: what the MASTER sends and the SLAVE pastes (its SYNCTHING
  ID and the session). The SLAVE creates the session at once and offers it
  back; the MASTER links it by itself, even with a computer it accepted
  before (that computer was never asked again: the invitation never came).
  The MASTER opens the approval of a new computer by itself; the SLAVE
  chooses its folder while it waits and sees each step with the time.
- **The ring alone**: LIVE SYNC reduced to its ring in a small window, kept
  above the others if wanted; filo in the menu bar / notification area on
  every system (open, sessions and their state, the ring alone, hide, quit).
- A red **DISCONNECT** button in the LIVE SYNC view; the button for the end
  of the queue moves to the title bar, as in syncto.

### Changed

- The SYNCTHING queue empties as files arrive, one line per file, saying
  SEND or RECEIVE and the other computer; the LIVE SYNC copies in the FTP
  queue say SEND / RECEIVE and S-FTP BACKUP or SERVER.
- "Import session" shows its buttons only (PASTE, IMPORT CONFIG, FIND,
  CANCEL; what each does on hover).
- DISCONNECT means the whole session everywhere, confirmed (the same as the
  menu); each way of a DUAL SYNC is chosen on its mode badge.
- Wording: SESSION ID wherever the SLAVE pastes; SYNCTHING (the mode) in
  capitals; the instructions sent to the other computer no longer name a
  "MODE ▾" menu; SLAVE badge outlined, MASTER filled; an S-FTP session's tab
  is violet; REFUSE and NOT NOW say what they do.
- Buttons and fields aligned on one line (folder fields, dialog buttons,
  DISCONNECT).

### Fixed

- **A download never writes straight into the file any more**: with
  "temporary files" off, a cut or a full disk destroyed the local file that
  was there. Downloads always go to `.filopart` first; the switch now only
  concerns sending.
- **LIVE SYNC S-FTP keeps the local file it replaces**: moved to the
  session's `.filo-trash` first (`name~YYYYMMDD-HHMMSS.ext`), as SYNCTHING
  does. filo never empties it.
- **Damaged preferences**: `preferences.json` and `queue.json` are written
  with fsync and kept as `.bak` at each start; a file that cannot be read is
  put aside and the `.bak` taken back (it used to be replaced by an empty
  profile: sites, trusted servers and saved passwords lost).
- The wait for the MASTER really stops at CANCEL (it went on polling, could
  create the session after CANCEL, and could answer another window).
- The SESSION ID no longer stays on "…" until filo restarts.
- "Session open" only once the MASTER shares the folder; a SYNCTHING ID
  alone no longer lands on an older session with the same computer; the
  MASTER logs a second computer pasting the SESSION ID of a linked session.
- The ring alone is never saved as the window size; a window closed in it
  starts full size again.
- SAVE on a DUAL SYNC with SYNCTHING off no longer switches SYNCTHING on.
- Deleting a session checks its id.
- A speed under 1 KB/s is rounded (it showed "359.3333333333333 B/s" on a
  small file).

## [0.7.1] — 2026-10-13

### Added

- **Local panel shortcuts** (Noar): Desktop, Downloads and a menu of the
  disks mounted now, beside the folder button. The folders are the ones the
  system names (`app.getPath`): the same on a Mac in French, a Windows folder
  moved to another disk, a Linux desktop in another language (XDG). The
  disks: `/Volumes` on a Mac (the start-up disk included), the drive letters
  and This PC on Windows, `/`, `/media/<user>`, `/run/media/<user>` and
  `/mnt` on Linux; read again at each click.

## [0.7.0] — 2026-10-13

### Added

- **Side bar** (Noar): TRANSFER, LIVE SYNC, SITES and SETTINGS on the left,
  each an icon and its name; the view shown takes its colour (TRANSFER
  green, LIVE SYNC the colour of the session shown). A blue dot on LIVE SYNC
  while a session runs, orange on a problem. The LIVE SYNC menu: click LIVE
  SYNC once its view is shown, or right-click it.
- **Start the queue at a time**: right-click START → At a time…; a STARTS
  badge shows it, right-click again to cancel; files added until then wait.
  filo must stay open.
- **Command after the queue** (Settings › After the queue, the model of
  ingesto's post-ingest command): run without a shell, the line cut into
  arguments, `{result} {done} {failed} {bytes} {local} {remote} {server}
  {direction}` replaced inside the arguments, never in the program. filo
  waits for it (30 min at most) before quit / sleep / shut down. A TEST
  button; the end-of-queue menu turns it on or off.
- **Check against the other side**: right-click in a panel; the selected
  files and folders, here and in the folder open on the other side, compared
  by a checksum the server computes (read back, after asking, when it
  cannot). Identical, different, only on one side; nothing transferred.
- **Favorite folders** for each server (the star beside the server path),
  shared by a site and a quick connection to the same address.
- **Quick Look** with the Space bar on a local file (Mac).
- **LIVE SYNC**:
  - the file moving now under the percentage of the ring; bytes and speed
    on one line;
  - PAUSE / RESUME on the SYNCTHING queue (the session stays connected;
    filo restarted resumes it);
  - a phone alert (ntfy) when a session cannot sync for N minutes, then when
    it works again (Settings › Notifications, off by default).

### Changed

- The connection bar: no label above the fields, each field's name inside it.
  Synchronized browsing sits between the two panels; the end action (quit,
  sleep, shut down) beside START / STOP / CLEAR; Settings in the side bar.
- Syncthing folders pull files in name order: the SYNCTHING queue moves from
  the top on both computers (the receiving one listed the first names as
  waiting while others arrived).
- The queue says FINISHED for 5 s, then IDLE with an empty bar
  (FINISHED · WITH ERRORS stays).
- The update notice: a small window (New version available, LATER / GET IT),
  as in syncto, ingesto and archivo; the version declined is not asked again.
- Settings: "Post command" is now "Command line" (it shows the commands that
  drive filo from a script).
- The texts that pointed to MODE ▾ now point to the side bar (right-click
  LIVE SYNC).
- README: new screenshots, LIVE SYNC ones added.

## [0.6.4] — 2026-10-12

### Changed

- **Site Manager** (Noar):
  - It opens as it was left: the folders open then, the site selected then,
    the same scroll. Nothing unfolds on its own.
  - Right-click on the empty space: New site, New folder. On a folder:
    Rename, Expand, Collapse, Duplicate, Delete (asked first; its sites go
    with it, and their remembered passwords). On a site: Rename, Duplicate,
    Delete (asked first). Rename happens in the list itself.
  - A NEW FOLDER button beside +. Folders exist on their own: an empty folder
    stays.
  - DELETE and DUPLICATE are no longer at the bottom of the form.
  - Drag and drop: a straight line between the rows, with a dot at its start
    (it used to follow the rounded corners of a row); a folder to drop into
    is tinted; anything dropped on the empty space goes to the top level.
- The folder created for a LIVE SYNC session imported with its server is
  called "LIVE SYNC" (was "Shared").

## [0.6.3] — 2026-10-12

### Added

- **Synchronized browsing shows what differs between the two sides**
  (FileZilla's two codes, Noar): the name of an item only on this side is
  highlighted in yellow, of a file newer on this side (or another size at the
  same date) in green; the row itself is not coloured. Under each panel, the
  count ("2 only here · 1 newer here"). A filter button beside the path
  (shown while synchronized browsing is on) keeps only what differs. Only the
  two folders shown are compared, not what their sub-folders hold; dates
  within 2 s, or within the same minute for a server that lists minutes
  only, count as the same.

## [0.6.2] — 2026-10-12

Code review (security, bugs, interface) before the first GitHub release.

### Added

- **DUAL SYNC is a sync between three places** (Noar: "une synchro 3 ways"):
  what is put on the S-FTP BACKUP by hand (a file, a folder) comes to the
  MASTER, and SYNCTHING takes it to the SLAVE; a file changed only on the
  server comes too. Changed on both sides: the MASTER's version wins, the
  server's is kept beside it. Deleted on the MASTER: deleted on the server.
  Deleted only on the server: sent again. A MASTER that only sends
  (LOCAL → REMOTE) brings nothing back.
- Colours of the modes everywhere: the LIVE SYNC ring, the queue (title,
  progress bar, graph, SPEED badge, glow) and the SYNCTHING queue take the
  colour of what they move: FTP client green, SYNCTHING blue, S-FTP violet,
  DUAL SYNC blue to violet. Checking files no longer turns the queue blue.
- **Logo and icon in turquoise** (#19C9B4), instead of FileZilla's red.

### Security

- **The S-FTP BACKUP never deletes what this session does not know**: only a
  path filo saw on this computer is deleted when it goes from here; what was
  put on the server by hand is brought here, never deleted, so a backup
  folder set by mistake on a shared folder is never emptied. The root of the
  server is refused as a backup folder.
- A local entry that cannot be read (a NAS hiccup) stops the backup pass
  instead of looking deleted; nothing is deleted under a folder reached
  twice through a link.
- Names from a server can never leave the synced folder: LIVE SYNC builds
  local paths with the same safe join as the file panels, and FTP listings
  drop names containing `\`. A relayed file's part name must be a bare name.
- A SLAVE takes the MASTER's direction and file filter only through
  SYNCTHING's own link, no longer from the `.filo-session` file on the server
  (anyone who can write there could have written it); only the name is taken
  from there.
- At start, filo checks that the port left by the previous Syncthing is a
  Syncthing before sending it its key.

### Fixed

- The S-FTP BACKUP now takes over when the other computer goes away while the
  folder is quiet (SYNCTHING sends no second status: filo looks again after
  15 s).
- DUAL SYNC: a file changed on both sides into the same file (SYNCTHING on
  one side, the backup on the other) no longer makes a conflict copy on the
  SLAVE; a file the S-FTP relay brought is not sent back up.
- Backup copies held while SYNCTHING works: marked, so a copy paused by hand
  is never resumed by filo, and a hold made before quitting is released
  after the restart. Switching the S-FTP BACKUP off, or deleting the session,
  stops its copies. A pass that finds SYNCTHING busy again holds its copies.
- A deletion on the backup first removes the copies still queued under that
  path. The status leaves "copying to the backup" when the copies are done
  (or says how many failed). Faster passes on large folders.
- Segment relay: the receiving filo no longer fails, now and then, when the
  sender gives the file its name while a segment is being read.

### Changed

- One name per thing: S-FTP BACKUP everywhere (no more "Failsafe"),
  "MODE ▾ → …" in every hint, AUTO in capitals, "Connections" in the
  settings too, "LIVE SYNC “name”:" in the journal, "New session" as the
  default name.
- Colours from the palette only (no stray values), errors in red, buttons
  and session tabs at the same heights and corners, hover states and labels
  for screen readers on icon buttons. Unused styles and code removed.

## [0.6.1] — 2026-10-12

### Changed

- Ring: IDLE gives way to **UP TO DATE** (both computers in step, or an S-FTP
  session with nothing left to copy) and **ALL UP TO DATE** (DUAL SYNC: both
  computers and the S-FTP BACKUP in step). The backup stops counting as up to
  date as soon as SYNCTHING moves files again.
- Speed graphs (ring and queue) move smoothly: they slide continuously, the
  scale grows and shrinks gently, and SYNCTHING's rate (a new value every
  2 s) is eased instead of drawn as steps.
- Connection bar: **MODE** (CLIENT / LIVE SYNC) at its left switches between
  the FTP client and the LIVE SYNC view, and stays at the same place in both;
  its ▾ opens the LIVE SYNC menu (the LIVE SYNC button of the title bar is
  gone). The connect button moved to the right of PASSWORD, under
  "CONNECT".
- Queue header: START, STOP and CLEAR (a broom; in the LOG tab it copies the
  log) on the left; the whole queue's percentage, big, under the title; a
  thin progress bar across the queue; the small ring, the speed figures over
  the graph and the dot before the title are gone. Badges: SPEED, PEAK (the
  fastest of the last minute), TIME LEFT, LEFT. Time elapsed in white.
- "AUTO" in capitals; CHECKSUM green when on, grey when off (no longer
  orange).

## [0.6.0] — 2026-10-12

### Added

- **DUAL SYNC** (replaces SYNCTHING FAILSAFE): SYNCTHING first, the fastest
  way. Once both computers are up to date and nothing moved for 30 s, the
  MASTER makes the server folder an exact copy of its own folder
  (**S-FTP BACKUP**): what is missing or changed is sent, what is no longer on
  the MASTER is deleted on the server (each computer keeps its deleted files
  in its own trash, `.filo-trash`). The SLAVE never writes the backup. When
  SYNCTHING has files to move again, the backup copies pause, then carry on.
  While the other computer cannot be reached, the files go through the server
  as before. A local folder that reads empty while the server holds files
  (a disk not mounted) deletes nothing.
- **SYNCTHING queue** in the queue panel: the files moving with their
  progress, the ones waiting, the last ones sent or received.
- **LIVE SYNC menu** on the LIVE SYNC button: New session, Import session as
  SLAVE, Connect / Disconnect (one line per session), Sessions….
- **File filter as chips**, each with ×, and a field to add one: `aep` or
  `.aep` becomes `*.aep`.

### Changed

- Ring: EST. TIME as MM:SS or H:MM:SS, without "~"; the ring fades when IDLE;
  "S-FTP BACKUP" while the backup is written.
- Session window: delete icon on each session (the bottom DELETE button is
  gone), 2 WAYS by default, "Import a config" renamed "Import session", a
  MASTER MODE / SLAVE MODE badge, shorter descriptions, REMOTE COMPUTER shows
  its name and ID with COPY.
- LIVE SYNC view: the role badge sits beside the computer's name; the SLAVE
  badge is green when connected, red with an icon when not; LINK says local
  network, internet or relay; ROLE is replaced by the sync way (SEND,
  RECEIVE, 2 WAYS).
- Default file filter shortened to `.DS_Store, ._*, Thumbs.db, *.tmp`. filo's
  own working files (`*.filopart`, `*.filoold`, `.*.filoparts`) are no
  longer shown and are always excluded. Filter entries may be separated by
  commas, semicolons, `|` or new lines.

### Removed

- The button of the LIVE SYNC view that switched to the file panels (the
  queue panel shows what moves). The LIVE SYNC menu still offers the switch.

## [0.5.0] — 2026-10-12

### Added

- **LIVE SYNC sessions of three kinds**, with one name and one colour each,
  everywhere in filo:
  - **SYNCTHING** (blue): straight between two computers running filo, peer
    to peer (Syncthing, shipped with filo), through the internet boxes or a
    relay when no direct path exists, encrypted end to end. No server.
  - **SYNCTHING FAILSAFE** (blue and violet): SYNCTHING while the remote
    computer can be reached; when it cannot, each filo syncs with a folder on
    a server and catches up from it. A file already identical on both sides
    is neither copied again nor seen as a conflict.
  - **S-FTP** (violet): a folder on an FTP, FTPS or SFTP server (as before).
- **MASTER / SLAVE**: the computer that creates a session is its MASTER, the
  one that imports it its SLAVE. The MASTER's version wins a file changed on
  both computers; the other version is kept beside it, named after its
  computer (`name.sync-conflict-<date>-from-<computer>.ext`), on the server
  too in FAILSAFE. The SLAVE takes the MASTER's direction (the other way
  round), session name and file filter, and follows their changes.
- **One way to set a session up: the MASTER sends, the SLAVE imports.** The
  MASTER saves a config file (SAVE CONFIG FILE…) or, for a SYNCTHING
  session, gives its SYNCTHING ID (shown in the LIVE SYNC view). The SLAVE
  opens LIVE SYNC → IMPORT A CONFIG: OPEN THE CONFIG FILE…, PASTE A
  SYNCTHING ID… (typos caught by the ID's check characters), or, FAILSAFE,
  FIND ON A SERVER… (the MASTER leaves `.filo-session` in the S-FTP folder,
  never a password). The MASTER then accepts the SLAVE, and chooses the
  session to share with it when it came by ID. The server password is typed
  by the SLAVE.
- **Trash** (SYNCTHING): a file deleted on one computer is deleted on the
  other too, but into that computer's trash, `.filo-trash` inside the synced
  folder: same disk (a 50 GB file is moved, not copied), never synced, never
  emptied by filo. Its size and an icon to open it in the LIVE SYNC view.
  S-FTP still deletes nothing.
- **The LIVE SYNC view**: while a session is connected, the main window shows
  it in place of the panels. At the top, LIVE SYNC and the session's name.
  On the left, this computer (MASTER or SLAVE, name, system, IP, SYNCTHING
  ID with copy and export, trash, folder). On the right, the remote computer
  and, FAILSAFE, the server, each with CONNECTED or DISCONNECTED (NOT LINKED
  YET, orange, until a SLAVE joins). In the centre, the session's mode badge
  (its kind, in its colour, and its state: plugged green, plugged orange when
  it cannot work, unplugged red; one click connects, disconnecting asks
  first), and a ring that fills the frame (Presto's): state, percentage,
  bytes, speed, files left, estimated time, the speed graph inside the ring,
  and arrows on its sides showing which way files are moving.
- **THIS COMPUTER**: its SYNCTHING ID, its port, the remote computers
  accepted.
- **`THIRD_PARTY_NOTICES.md`**: every component inside a filo build (the
  184 Rust crates of the transfer engine, the JavaScript packages, Syncthing,
  the icons and the font), its licence and its licence text, placed next to
  the application in every build. Generated by `scripts/third-party-notices.js`.

### Changed

- **LIVE SYNC window**: CREATE A SESSION or IMPORT A CONFIG to start; the
  three kinds in syncto's style; one form per kind (session name, bookmark,
  direction, local folder, S-FTP folder with a server browser, AUTO WATCH
  with its interval or Custom…, FILE FILTER) and CANCEL, SAVE, SAVE &
  CONNECT. Directions in this order: 2 WAYS, LOCAL → REMOTE (or S-FTP),
  REMOTE (or S-FTP) → LOCAL. "Exclude" is now FILE FILTER, "Server folder"
  S-FTP FOLDER; USE PANEL is gone. Icons rather than text buttons, each with
  a tooltip. On a SLAVE, what the MASTER decides is greyed, and SHARE is not
  offered.
- **LIVE SYNC is blue**: the button breathes blue while a session is on, is
  grey when none is, orange when a session has a problem or a computer waits
  for your answer.
- **One badge design** across filo (LIVE SYNC, the queue, the connection
  bar, the settings).
- **Sharing an S-FTP session** with another team: a config file only (no
  more text to copy, no more mail).
- **File filters in SYNCTHING** are case-insensitive, as for S-FTP.

### Fixed

- **FAILSAFE switched on, SYNCTHING switched off**: the failsafe now works
  (it waited for Syncthing as long as the other computer was online).
- **FAILSAFE switched off**: the server is no longer used when the remote
  computer goes away.
- **A file deleted in SYNCTHING** (it is in the trash) is no longer brought back
  by the S-FTP failsafe from the server.
- **The SLAVE's direction** when it imports from the server (it took the
  MASTER's for a moment), and a server copy that lags no longer beats a newer
  file on the SLAVE at the first look.
- **One missed look at Syncthing** no longer starts the failsafe while the
  other computer is still there.
- **SYNCTHING**: a Syncthing that stopped and could not restart is shown as an
  error (it stayed "connected"); no second polling loop after the LIVE SYNC
  view opens and closes; no Syncthing left running when quitting during a
  change; the trash is excluded before a new folder starts; two conflict
  copies of the same second never overwrite each other.
- **"Already there" rule**: an unknown answer skips the file instead of
  overwriting it.
- Files left open after a network error during a download.
- The LIVE SYNC view no longer rebuilds itself every second (tooltips and
  clicks were sometimes lost). A deleted session takes its settings folder
  with it. Errors of the LIVE SYNC window are shown instead of failing
  silently. Long deletions on a server show their progress.
- A key passphrase or a password that could not be saved (no keychain) now
  says so.

### Security

- **`.filo-session` on the server**: a SLAVE ignores a file that does not
  carry its MASTER's SYNCTHING ID (someone with write access to the server
  folder could otherwise change its direction or filter).
- **Config import**: the server part is checked again by filo, never taken as
  the window sends it.
- **`scripts/push_github.command`**: refuses to send without `.gitignore`,
  and always leaves out `.env`, certificates and private keys.

## [0.4.0] — 2026-10-11

### Changed

- **Time left and time elapsed in the queue header**, under its title; time
  left in large type (the remaining data at the speed of the last 10 seconds,
  so it does not jump at every tick).
- **A running file shows** transferred / total, its speed, time elapsed and
  time left; for a file in segments, the number of transfers at once alone
  (details in its tooltip). "N at once" and "N of M done" are gone.
- **Auto starts a file SENT in segments on one connection**, and adds more
  only if they make it faster. Several connections writing into the same file
  at several places held a NAS's disks back: on a DS920+, 21.8 GB sent in
  1'53" on one connection, 2'42" on four (FileZilla: 2'01"). Received files
  still start on four (2'12", FileZilla 3'13").

- **AUTO SYNC is now LIVE SYNC**, everywhere: the button, the window, the
  messages, the documentation, and the command line (`filo livesync`; the
  earlier `filo sync` still works). Nothing to redo: saved syncs, shared
  `.filosync` files and `filo-sync:` lines keep working as they are.
- **The connection button is an icon only**: green plug in when connected,
  red plug apart when not. The words are in its tooltip.
- **Times in QUEUE, FAILED and DONE**: each file shows when it was queued or
  started, when it finished, how long it took, and its average speed once
  done. The duration counts from the last start of the file (after a pause or
  a retry, that last pass).

### Added

- **Rust transfer engine for SFTP** (`engine/`, the program `filo-engine`):
  the bytes of each file or segment go straight between the disk and the
  network through it, outside Node, fingerprinted on the way; it also reads
  files back for verification. In the app, on a DS920+ with a 21.8 GB file:
  received in 2'12" and sent in 1'53", against 3'13" and 2'01" for FileZilla
  right after on the same file. It applies the speed limit itself, logs in with a password,
  keyboard-interactive or a key (OpenSSH, PEM, and PuTTY .ppk handed over as
  PEM), and must see the server identity filo already checked. filo falls back
  to its built-in engine when the program is missing or refused.
  `scripts/bench-engine.command` measures it against OpenSSH.
- **The builds include the Rust engine** (`scripts/engine-build.js`, run by
  electron-builder before packing): Rust is needed on the build machine, and
  for Windows built on a Mac, MinGW (`brew install mingw-w64`). Without them
  the app is built anyway, with the built-in engine, and the build says so.

## [0.3.5] — 2026-10-10

### Added

- **Move by drag and drop inside a panel**, local or server: drop files or
  folders onto a folder of the same list, or onto ".." to move them up one
  level. Never over something already there, never a folder into itself;
  between two disks, it is refused (use the other panel to copy).
- **Right-click on QUEUE, FAILED or DONE** to clear that list straight away
  (the same questions as CLEAR when something would be lost).
- **AUTO SYNC** (SYNC button, title bar): pairs of a local folder and a
  server folder, kept in step LOCAL → SERVER, SERVER → LOCAL or 2 WAYS. The
  local folder is watched, the server looked at on an interval. A file is
  sent only once it is stable (same size and date on two looks 10 s apart).
  Nothing is ever deleted; a deletion on one side is respected (not sent
  again) and reported; a file changed on both sides is a conflict, left as it
  is and reported. Each pair keeps its own exclusions.
- **Share a sync with another team**: a `.filosync` file or a `filo-sync:`
  line to paste (by mail, macOS share menu). It carries the server, the
  folders, the direction (reversed for the receiver) and the server's
  fingerprint, never a password. The receiver chooses the local folder.
- **Segment relay** (SFTP): when one filo sends a large file in segments, the
  other filo following the same sync downloads each segment as soon as it is
  announced and verified, and assembles the file once the last one is there.
- **Command line**: `filo upload | download | sync | queue | status`, with
  `--wait`, `--json`, `--out`, `--background`, and exit codes for scripts.
  It drives the filo that is open (started if needed) through a local channel
  of this user only; no password on the command line. See `docs/CLI.md`.
- **Settings → POST COMMAND**: the command for this computer (COPY), an (i)
  button listing the commands with examples to copy, and on a Mac an INSTALL
  button for the `filo` command in the Terminal (also in the filo menu).
- **scripts/bench-nas.command**: a speed test against a NAS (SFTP, FTPS, FTP,
  SMB and OpenSSH for reference), with few questions; it finds a folder where
  the account may write.

### Changed

- **The connection button shows the state**: red NOT CONNECTED (plug apart),
  green CONNECTED (plug in). Hovering says what a click does: CONNECT or
  DISCONNECT.
- **A file never starts a transfer by itself**: a double-click opens its menu,
  Enter renames it. A folder still opens with a double-click or Enter.
  Transfers: drag to the other panel, UPLOAD / DOWNLOAD, or the menu.
- **HOME** written next to the house icon (the folder the server opens on).
- **The speed graph only shows during a run**; it stays, frozen, while the
  queue is paused, and goes when the queue finishes or is stopped.

### Fixed

- **SFTP downloads 2 to 3 times slower than they should be on a fast local
  network.** The read depth (requests in flight) was sized on the average
  round trip, which is mostly the queue of requests ahead: it asked for twice
  itself every second, up to 1024 requests, even on a LAN. It is now sized on
  the shortest round trip: one connection went from 129-218 MB/s to 400-440
  MB/s on the test machine (OpenSSH: 414). Read-back verification of uploads
  goes through the same path and gains as much.
- **SFTP: a larger receive window, and larger requests when sending.**
  filo grants the server a receive window covering what is in flight from
  the first request (up to 32 MB; ssh2 kept 2 MB). Uploads ask for as much
  per request as the server announces (OpenSSH, so every Synology: ~255 KB;
  other servers: the size they take, which also removes a second small
  write per request that ssh2 used to cut off). Downloads stay at 32 KB per
  request: larger ones looked faster on a short test the NAS served from
  memory, and were up to 3 times slower on a real 20 GB file read from its
  disks. A resumed upload starts up to 16 MB before the end of the partial
  file (was 2 MB), since that much may be in flight.
  Measured on a DS920+ (2.5 Gb/s), a 20 GB file, Auto: upload 2'29",
  download 2'30" (FileZilla 3.71: 3'04" and 2'40").
- **The SFTP connection line in the log names the cipher** (and the MAC
  when it is a separate one).
- **Sites that log in with an SSH key could not transfer**: browsing worked,
  but every upload and download was refused ("wrong user name, password or
  key"). The key reached the transfer threads in a form the SSH library does
  not take, and the login went without it. Present since transfers moved to
  threads; password sites were not affected.

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
