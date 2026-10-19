#!/usr/bin/env bash
# trove - single-entry launcher.
cd "$(dirname "$0")" || exit 1
./trove start
echo
echo "✓ everything running. close this Terminal window when you're done."
echo "  (run ./trove stop if you want to kill the servers explicitly)"
read -n 1 -s -r -p "press any key to dismiss…"
