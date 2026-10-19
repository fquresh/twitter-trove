#!/usr/bin/env bash
# gif.sh <name> [extra -vf prefix, e.g. "setpts=0.5*PTS"]  - converts /tmp/trove-video/<name>.json recording to docs/media/<name>.gif
set -euo pipefail
F=$(command -v ffmpeg); OUT="$(cd "$(dirname "$0")/../../docs/media" && pwd)"; D=/tmp/trove-video; N=$1; PRE=${2:-}
read -r P S E < <(python3 -c "import json;d=json.load(open('$D/$N.json'));print(d['path'],d['start'],d['end']-d['start'])")
VF="${PRE:+$PRE,}fps=12,scale=1000:-1:flags=lanczos"
$F -y -loglevel error -ss "$S" -t "$E" -i "$P" -vf "$VF,palettegen=stats_mode=diff" $D/pal_$N.png
$F -y -loglevel error -ss "$S" -t "$E" -i "$P" -i $D/pal_$N.png -lavfi "$VF[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" "$OUT/$N.gif"
ls -la "$OUT/$N.gif"
