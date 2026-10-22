# Contributing to filo

Thanks for taking the time. filo moves other people's files, often large and
irreplaceable rushes, so the bar for changes to the transfer engine is
deliberately high.

## Licensing of contributions

filo is **GPL-3.0-or-later**. By opening a pull request you agree that your
contribution is licensed under the same terms. Do not paste code from other
projects unless it is GPL-compatible and you say so in the pull request.

filo's *behaviour* is modelled on FileZilla, whose source served as a reference,
but filo contains **none of its code**, and it must stay that way. Describe the
behaviour you want; do not translate FileZilla's C++.

## Before you open a pull request

```bash
npm install
npm test          # the engine test suite (~1.5 min, a real SFTP server in-process)
npm run dev       # run the app
```

`npm test` must stay green. Optional checks against real FTP / FTPS servers are
described at the top of `test/run-tests.js`.

**Any change to the engine needs a test.** The suite lives in
`test/run-tests.js` and has no framework: `ok()` and `eq()` against a scratch
folder and an in-process SFTP server. A test of pausing or stopping must use a
file that cannot finish on its own during the wait (a speed limit does that),
or a stop that does not work will pass unnoticed.

## Ground rules

- **Data first.** Never write over a file the user did not choose to replace;
  never rename a `.filopart` before it is complete and verified.
- **No password in clear**, anywhere: settings, queue, logs, exports, errors.
- **Interface and code in English.** Interface text is short and plain; buttons
  are uppercase (CONNECT, REMOVE).
- **Three systems.** macOS, Windows and Linux. Say in the pull request on
  which ones you tried it.
- **Small, explained changes.** Say why, not only what. The comments in
  `src/main/core/queue.js` and `transfer.js` explain the traps already met;
  read them before touching the queue.

## Reporting a bug

Open an issue with the version (bottom left of the window), the system, the
protocol, what you did, what you expected, and the relevant lines of the Log
tab (they contain no password; remove host names if you prefer).
