#!/bin/bash
#
# filo — speed test of the Rust engine (prototype) against OpenSSH, with your
# NAS. Double-click it. It builds the engine first (engine/, needs Rust: it
# offers to install it the first time), then asks the same questions as
# bench-nas.command. The results go to ~/filo-bench (send the results-….txt).

cd "$(dirname "$0")/.." || exit 1
pause_exit() { echo ""; read -p "Press Enter to close this window..." _; exit "$1"; }

command -v node >/dev/null 2>&1 || { echo "Node.js is not installed (https://nodejs.org)."; pause_exit 1; }
if [ ! -d node_modules ]; then
  echo "First run — downloading dependencies…"
  npm install --no-audit --no-fund --loglevel=error || pause_exit 1
fi

# Rust: rustup puts cargo in ~/.cargo/bin, which a new Terminal may not know yet.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is not installed on this Mac. It is needed to build the engine"
  echo "(about 1 GB in ~/.rustup and ~/.cargo, a few minutes, nothing else changed)."
  read -p "Install it now? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || pause_exit 1
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal || pause_exit 1
  . "$HOME/.cargo/env"
fi
if [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  echo "The Xcode command line tools are needed (the linker). Run: xcode-select --install"
  pause_exit 1
fi

echo ""
echo "Building the engine (the first time takes a few minutes)…"
cargo build --release --manifest-path engine/Cargo.toml || pause_exit 1

echo ""
echo "filo — Rust engine against OpenSSH (wired connection, nothing else transferring)"
echo ""
BENCH_MODE=engine node scripts/bench-nas.js
status=$?
[ $status -eq 0 ] && open "$HOME/filo-bench" 2>/dev/null
pause_exit $status
