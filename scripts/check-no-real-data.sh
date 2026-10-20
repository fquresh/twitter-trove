#!/usr/bin/env bash
# Fails when a tracked or new (not ignored) file holds an X-style id (18 or 19
# digits) that is not a documented fictional id. A real post, list, or topic id
# can tie the repo to a real account. The generated seed in webapp/public/seed/
# is exempt.
#
# A fictional id is a round base plus a small offset: 10, 17, 18, or 19, then
# eleven zeros, then six digits. The seed uses the 18 base. Test fixtures use
# the 10, 17, and 19 bases.
#
# Usage: scripts/check-no-real-data.sh [repo-root]
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel)}"
cd "$root"

id_re='(^|[^0-9A-Za-z_])[0-9]{18,19}([^0-9A-Za-z_]|$)'
fictional_re='^(10|17|18|19)0{11}[0-9]{6}$'
found=0

while IFS= read -r -d '' file; do
  case "$file" in
    webapp/public/seed/*) continue ;;
  esac
  [[ -f "$file" ]] || continue
  # -I skips binary files (images, wasm).
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    line="${hit%%:*}"
    id="$(printf '%s' "${hit#*:}" | tr -cd '0-9')"
    if [[ ${#id} -ge 18 && ! "$id" =~ $fictional_re ]]; then
      echo "$file:$line: $id is not a documented fictional id"
      found=1
    fi
  done < <(grep -I -n -o -E "$id_re" "$file" 2>/dev/null || true)
done < <(git ls-files -z --cached --others --exclude-standard)

if [[ "$found" -ne 0 ]]; then
  echo "✗ real-looking ids found. Use a fictional id such as 1900000000000000001."
  exit 1
fi
echo "✓ no real-looking ids in tracked or new files"
