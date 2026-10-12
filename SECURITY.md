# Security policy

## Reporting a vulnerability

Email **contact@just-edit.fr** rather than opening a public issue. Say what you
found, how to reproduce it, and what an attacker could do with it. Expect an
acknowledgement within a few days. Only the latest release is maintained.

## What filo protects, and how

filo connects to servers you choose and writes into folders you choose. The
areas worth scrutiny:

- **Passwords.** Kept in the operating system's credential store (macOS
  Keychain, Windows Credential Manager, libsecret on Linux) through Electron's
  `safeStorage`. Never in a settings file, the queue, the logs, an export or
  the quick-connect history, and never handed to the window. On Linux, when no
  real keyring exists, Electron offers a "store" that is plain text: filo
  refuses it and asks for the password at each connection.
- **Server identity.** SSH host keys and FTPS certificates are shown with their
  fingerprint at the first connection and pinned once you accept them. A key or
  a certificate that changes later stops the connection before any password is
  sent. Accepting a change is deliberate: forget the old one in Settings.
  Every FTPS data connection must resume the checked TLS session or present
  the very same certificate.
- **FTP data connections** always go to the server's own address, whatever a
  passive-mode reply says. In active mode, only the server's address may
  connect back. Plain FTP is marked *not encrypted* wherever it appears.
- **What a server sends.** A name that is really a path (`..`, `/`, `\`) is
  dropped; names are made safe for the local disk (Windows reserved names and
  characters included), so a folder download cannot write outside the folder
  you chose. Server checksums run through a shell command only for names
  without quotes, backslashes or control characters; other names are verified
  by reading the file back.
- **Files in transit** are written as `name.filopart` and renamed only once
  complete and verified.
- **The application.** The window is sandboxed with context isolation and a
  strict Content Security Policy; everything goes through a small preload
  bridge. It cannot navigate away, open other windows or request device
  permissions. The executable carries Electron *fuses*: it cannot be started as
  a plain Node.js, with a debugger or with `NODE_OPTIONS`, and only loads its own
  integrity-checked `app.asar`.
- **The Rust transfer engine** (`engine/`, SFTP only) is a separate program
  that filo starts, one per connection. The password or the key reach it
  through a pipe, never its command line nor a file; a PuTTY key is
  deciphered by filo and handed over in memory. It opens its own SSH
  connection and refuses any server whose identity is not the one filo has
  already checked and pinned; nothing is sent before that check.
- **The command line** (`docs/CLI.md`) reaches the running filo through a
  Unix socket in the profile folder (macOS, Linux; this user only) or a named
  pipe (Windows), plus a random token re-made at each start and kept in a file
  readable by this user only. Nothing listens on the network, and no password
  is ever passed on the command line: commands use the saved sites.
- **A shared live sync** (`.filosync` file or `filo-sync:` line) carries the server
  address, folders and the server's fingerprint, never a password; the
  receiving filo pins that fingerprint, so a different server is refused.
- **SYNCTHING** (a live sync between two filo) runs Syncthing, shipped unmodified
  next to filo (its SHA-256 is checked at build time against the release). It
  only starts once a SYNCTHING live sync exists. Each computer has a key pair; the
  other side is identified by its ID (a hash of its certificate) and the data
  is encrypted end to end (TLS). Another computer is never trusted on its
  own: the user accepts it, its ID shown. Syncthing's web interface only
  listens on 127.0.0.1, on a new port at each start, and is locked by a random
  password nobody knows; filo uses the API key of its configuration (a file of
  this user only), passed in the environment, never on a command line.

## SYNCTHING: what the network sees

- Syncthing listens on TCP and UDP port 22000 (or the next free one) on every
  network of the computer, and asks the router to open it (UPnP / NAT-PMP).
  macOS and Windows ask once whether to allow it: allow it, or SYNCTHING only works
  through relays.
- Syncthing's public **discovery servers** learn this computer's ID and IP
  address, so the other filo can find it. Its public **relays** carry the data
  when no direct path exists: they only see encrypted traffic.
- A file deleted on one computer is deleted on the other too, but into that
  computer's trash (`.filo-trash` inside the synced folder, never synced,
  never emptied by filo).
- A SYNCTHING FAILSAFE session leaves one file of filo's on the server,
  `.filo-session`, in the S-FTP folder: the session's settings for the SLAVE
  (names, direction, filter, SYNCTHING ID, server address and fingerprint).
  Never a password. Anyone who can read that folder can read it; a computer
  that imports it still has to be accepted by hand on the MASTER. Anyone who
  can write there could replace it: a SLAVE only takes settings that carry
  its MASTER's SYNCTHING ID (a file without it, or with another one, is
  ignored), and only the name, the direction and the file filter, never a
  folder or a server.
- The config file a MASTER saves holds the same, never a password. Its
  server identity is shown at import ("given by the file") and trusted when
  you confirm; a different identity already trusted on this machine is
  refused.
- A file filter never becomes a Syncthing instruction: its own marks (`!`,
  `(?d)`, `#include`) are dropped, and the trash is always left out first.

## Known limits, stated plainly

- The first connection to a server trusts what you accept: check the
  fingerprint with the server's administrator when it matters.
- Downloaded files are **not** marked as coming from the internet (no macOS
  quarantine flag, no Windows `Zone.Identifier`): Gatekeeper and SmartScreen do
  not check them when you open them.
- The Windows build is not code-signed.
- On Ubuntu 24.04 and later, the AppImage cannot install the AppArmor profile
  Electron's sandbox needs; the `.deb` does.
