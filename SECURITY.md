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

## Known limits, stated plainly

- The first connection to a server trusts what you accept: check the
  fingerprint with the server's administrator when it matters.
- Downloaded files are **not** marked as coming from the internet (no macOS
  quarantine flag, no Windows `Zone.Identifier`): Gatekeeper and SmartScreen do
  not check them when you open them.
- The Windows build is not code-signed.
- On Ubuntu 24.04 and later, the AppImage cannot install the AppArmor profile
  Electron's sandbox needs; the `.deb` does.
