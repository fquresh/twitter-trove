#!/usr/bin/env bash
# trove - single-entry launcher.
# Default canonical path uses OPENROUTER_API_KEY (Gemini Flash); enrich.py also
# uses OPENROUTER (vision) and VOYAGE_API_KEY (embeddings). All read from .env.
cd "$(dirname "$0")" || exit 1

# If neither key is set in env or .env, walk the user through setup.
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

./trove update
echo
read -n 1 -s -r -p "press any key to dismiss…"
