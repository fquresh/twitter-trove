#!/usr/bin/env bash
# Self-test for scripts/check-no-real-data.sh in a throwaway git repo.
# The real-looking id is built at run time, so this file stays clean.
#
# Run from the repo root: bash tests/test_check_no_real_data.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$REPO/scripts/check-no-real-data.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
expect() {
  local name="$1" want="$2" got=0
  bash "$CHECK" "$WORK" > "$WORK.out" 2>&1 || got=$?
  if [[ "$want" == pass && "$got" -eq 0 ]] || [[ "$want" == fail && "$got" -ne 0 ]]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (exit $got)"; cat "$WORK.out"; FAILS=$((FAILS + 1))
  fi
  rm -f "$WORK.out"
}

real_looking="1234567""890123456789"
git -C "$WORK" init -q
mkdir -p "$WORK/webapp/public/seed" "$WORK/src"

echo "check-no-real-data"
printf 'const id = "1900000000000000001"; const seed = 1800000000000000042;\n' > "$WORK/src/a.ts"
expect "fictional ids pass" pass

printf 'id: %s\n' "$real_looking" > "$WORK/webapp/public/seed/tweets.html"
expect "the generated seed is exempt" pass

printf 'url = "https://x.com/i/lists/%s"\n' "$real_looking" > "$WORK/src/b.ts"
expect "a real-looking id in a new file fails" fail

git -C "$WORK" add -A
expect "a real-looking id in a tracked file fails" fail

printf 'id = "%s"\n' "${real_looking:1}" > "$WORK/src/b.ts"
expect "an 18-digit real-looking id fails" fail

printf 'sha = "a%sz"\n' "$real_looking" > "$WORK/src/b.ts"
expect "digits inside a longer token are ignored" pass

if [[ "$FAILS" -gt 0 ]]; then
  echo "$FAILS check(s) failed"
  exit 1
fi
echo "all checks passed"
