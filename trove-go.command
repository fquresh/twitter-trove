#!/usr/bin/env bash
# trove - single-entry launcher.
#   1. update derived data (classify new tweets + enrich)
#   2. boot the webapp + wiki server
#   3. open the browser
# After it opens, click the ⟳ button in the top nav to pull the fresh data
# into the webapp without dragging files.
cd "$(dirname "$0")" || exit 1

# Walk the user through key setup if OpenRouter isn't on file yet.
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  HAS_ENV_KEY=0
  if [[ -f .env ]] && grep -qE '^OPENROUTER_API_KEY=.+' .env; then
    HAS_ENV_KEY=1
  fi
  if [[ "$HAS_ENV_KEY" -eq 0 ]]; then
    echo "no OpenRouter key on file. let's add it now (one-time setup)."
    ./trove set-key
  fi
fi

./trove go
echo
echo "✓ ready. close this Terminal window when you're done."
echo "  (run ./trove stop if you want to kill the servers explicitly)"
read -n 1 -s -r -p "press any key to dismiss…"
