#!/usr/bin/env bash
# Checks that ./trove never puts a secret in a process argv, where any local
# account can read it with `ps`, and that the local server token stays private.
# Uses only dummy values in a temp directory.
#
# Run from the repo root: bash tests/test_trove_secrets.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

# A sandbox copy: ROOT, .env, and the logs dir all resolve inside $WORK/root.
mkdir -p "$WORK/root" "$WORK/shim"
cp "$REPO/trove" "$WORK/root/trove"
printf 'DEEPSEEK_API_KEY=old-dummy\nWIKI_PORT=8765\n' > "$WORK/root/.env"

# Shims log their argv, then run the real tool. curl is a fake: it records the
# header file it gets with -H @file and answers like the R2 REST API.
ARGV_LOG="$WORK/argv.log"
for tool in sed awk grep; do
  real="$(command -v "$tool")"
  printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "%s"\nexec "%s" "$@"\n' "$tool" "$ARGV_LOG" "$real" \
    > "$WORK/shim/$tool"
  chmod +x "$WORK/shim/$tool"
done
cat > "$WORK/shim/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "curl \$*" >> "$ARGV_LOG"
out=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -o) out="\$2"; shift ;;
    -H) if [[ "\$2" == @* ]]; then
          f="\${2#@}"
          printf '%s\n' "\$f" > "$WORK/hdr_path"
          ls -l "\$f" | cut -c1-10 > "$WORK/hdr_mode"
          cat "\$f" > "$WORK/hdr_body"
        fi; shift ;;
  esac
  shift
done
printf '{"success": true}' > "\$out"
printf '200'
EOF
chmod +x "$WORK/shim/curl"

SECRET_TOKEN="dummy-oauth-token-7f3a"
printf 'oauth_token = "%s"\n' "$SECRET_TOKEN" > "$WORK/wrangler.toml"

# A value with every character that broke the old sed edit or a later `source`.
TRICKY='a&b|c\d"e'"'"'f $HOME `echo pwned` ;g'

echo "trove: secrets stay out of argv"
(
  export PATH="$WORK/shim:$PATH"
  export WRANGLER_CONFIG="$WORK/wrangler.toml"
  export CLOUDFLARE_ACCOUNT_ID="dummy-account"
  # shellcheck disable=SC1091
  source "$WORK/root/trove"
  set +e
  write_env_var DEEPSEEK_API_KEY "$TRICKY"
  write_env_var VOYAGE_API_KEY "pa-dummy|new&value"
  echo '{}' > "$WORK/payload.json"
  r2_object_put_rest dummy-bucket data.json "$WORK/payload.json" application/json gzip > "$WORK/put.out"
  echo "rc=$?" >> "$WORK/put.out"
  ensure_wiki_token > /dev/null
  cp "$WIKI_TOKEN_FILE" "$WORK/token.first"
  ensure_wiki_token > /dev/null
  printf '%s' "${TROVE_WIKI_TOKEN-unset}" > "$WORK/token.env"
)

ENV_OUT="$WORK/root/.env"
read_back() {
  env -i HOME="$WORK" PATH=/usr/bin:/bin /bin/bash -c 'set -a; source "$1" >/dev/null 2>&1; set +a; printf "%s" "${!2-}"' _ "$ENV_OUT" "$1"
}

check "write_env_var round-trips & | \\ and quotes through source" \
  '[[ "$(read_back DEEPSEEK_API_KEY)" == "$TRICKY" ]]'
check "write_env_var appends a new key" \
  '[[ "$(read_back VOYAGE_API_KEY)" == "pa-dummy|new&value" ]]'
check "write_env_var keeps other keys" '[[ "$(read_back WIKI_PORT)" == "8765" ]]'
check "write_env_var replaces, not duplicates" \
  '[[ "$(grep -c "^DEEPSEEK_API_KEY=" "$ENV_OUT")" == 1 ]]'
check ".env stays mode 600" '[[ "$(ls -l "$ENV_OUT" | cut -c1-10)" == "-rw-------" ]]'
check "write_env_var leaves no temp or .bak file next to .env" \
  '[[ "$(ls -A "$WORK/root" | grep -v -e "^trove$" -e "^.env$" -e "^.trove-logs$" -e "^.wiki_token$")" == "" ]]'
check "no env value reaches sed, awk, or grep argv" \
  '! grep -F -e "a&b|c" -e "pa-dummy|new" "$ARGV_LOG" >/dev/null'

check "r2_object_put_rest reports success" 'grep -q "^rc=0$" "$WORK/put.out"'
check "OAuth token is not in curl argv" '! grep -F "$SECRET_TOKEN" "$ARGV_LOG" >/dev/null'
check "curl got the header from a file" \
  '[[ "$(cat "$WORK/hdr_body" 2>/dev/null)" == "Authorization: Bearer $SECRET_TOKEN" ]]'
check "header file was mode 600" '[[ "$(cat "$WORK/hdr_mode" 2>/dev/null)" == "-rw-------" ]]'
check "header file is gone after the call" \
  '[[ -s "$WORK/hdr_path" && ! -e "$(cat "$WORK/hdr_path")" ]]'

TOKEN_FILE="$WORK/root/.wiki_token"
check "ensure_wiki_token writes a long random token" \
  '[[ "$(wc -c < "$TOKEN_FILE" | tr -d " ")" -ge 40 ]]'
check "the token file is mode 600" '[[ "$(ls -l "$TOKEN_FILE" | cut -c1-10)" == "-rw-------" ]]'
check "ensure_wiki_token keeps an existing token" 'cmp -s "$TOKEN_FILE" "$WORK/token.first"'
check "the token is not exported to the launcher shell" '[[ "$(cat "$WORK/token.env")" == "unset" ]]'

if [[ "$FAILS" -gt 0 ]]; then
  echo "$FAILS check(s) failed"
  exit 1
fi
echo "all checks passed"
