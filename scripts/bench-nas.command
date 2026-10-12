#!/bin/bash
#
# filo — speed test with your NAS. Double-click it.
# Two questions: which of your filo sites, and its password (hidden, never
# written anywhere). Everything else is automatic; the results go to
# ~/filo-bench (send the results-….txt file).
#
# For a comparison with the Finder, mount a share of the NAS first
# (Finder → Go → Connect to Server): the test finds it by itself.

cd "$(dirname "$0")/.." || exit 1
pause_exit() { echo ""; read -p "Press Enter to close this window..." _; exit "$1"; }

command -v node >/dev/null 2>&1 || { echo "Node.js is not installed (https://nodejs.org)."; pause_exit 1; }
if [ ! -d node_modules ]; then
  echo "First run — downloading dependencies…"
  npm install --no-audit --no-fund --loglevel=error || pause_exit 1
fi

echo ""
echo "filo — speed test with your NAS (wired connection, nothing else transferring)"
echo "About 15 to 30 minutes."
echo ""
node scripts/bench-nas.js
status=$?
[ $status -eq 0 ] && open "$HOME/filo-bench" 2>/dev/null
pause_exit $status
