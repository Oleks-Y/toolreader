#!/usr/bin/env bash
# Regenerates site/demo/ledger.json, the curated demo's data, from a demo repo whose commits
# `codex exec` made, and that repo's Codex rollouts:
#
#   site/demo/make-data.sh DEMO_REPO      (CODEX_HOME defaults to ~/.codex)
#
# Reads both, writes neither: curate.py copies the rollouts into a temp dir and rewrites the copies,
# and the sync runs in Docker so the repo copy really lives at /work/wordfreq, the neutral path the
# rollouts are rewritten to. The result replaces ledger.json only if it passes the privacy gate.
set -euo pipefail

DEMO_REPO=${1:?usage: make-data.sh DEMO_REPO}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/site/demo/ledger.json
TMP=$(mktemp -d /tmp/wordfreq-demo.XXXXXX)
# KEEP=1 keeps the curated copies, e.g. to point the viewer at them for screenshots.
trap '[ -n "${KEEP:-}" ] || rm -rf "$TMP"' EXIT

git clone -q --no-local "$DEMO_REPO" "$TMP/wordfreq"
git -C "$TMP/wordfreq" remote remove origin
python3 "$ROOT/site/demo/curate.py" "$DEMO_REPO" "${CODEX_HOME:-$HOME/.codex}" "$TMP/codex"

(cd "$ROOT" && vp run build)
docker run --rm --network none \
  -v "$TMP/wordfreq:/work/wordfreq" -v "$TMP/codex:/codex" -v "$ROOT/dist:/tr/dist:ro" -v "$TMP:/out" \
  -w /work/wordfreq -e HOME=/home/dev -e T3_DB=/nonexistent \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -e GIT_AUTHOR_NAME="Demo Dev" -e GIT_AUTHOR_EMAIL=demo@example.com \
  -e GIT_COMMITTER_NAME="Demo Dev" -e GIT_COMMITTER_EMAIL=demo@example.com \
  node:24.13.1-bookworm sh -c '
    mkdir -p "$HOME"
    node /tr/dist/bin.mjs ledger sync --source codex-rollouts --codex-home /codex --range main
    node /tr/dist/bin.mjs ledger site --range main --out /out/site'

# The page's inlined range (already through `publicRange`) is the demo's data. It replaces
# ledger.json only if it passes the privacy gate, which lists what it rejects.
python3 - "$TMP/site/index.html" "$TMP/ledger.json" <<'PY'
import json, re, sys
html = open(sys.argv[1], encoding="utf-8").read()
data = re.search(r'<script type="application/json" id="ledger-data">(.*?)</script>', html, re.S)
json.dump(json.loads(data.group(1)), open(sys.argv[2], "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
node "$ROOT/scripts/privacyGate.ts" "$TMP/ledger.json"
cp "$TMP/ledger.json" "$OUT"
echo "$OUT"
[ -z "${KEEP:-}" ] || echo "kept $TMP"
