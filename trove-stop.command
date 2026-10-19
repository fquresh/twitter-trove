#!/usr/bin/env bash
# trove - single-entry launcher.
cd "$(dirname "$0")" || exit 1
./trove stop
echo
read -n 1 -s -r -p "press any key to dismiss…"
