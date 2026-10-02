#!/usr/bin/env bash
# Regenerates site/demo/ledger.json, the curated demo's data, from the wordfreq demo repo
# (four commits made by `codex exec`) and its Codex rollouts. Reads both, writes neither: it works
# on copies in a temp dir. The sync runs in Docker so the repo really lives at /work/wordfreq,
# the neutral path the copied rollouts are rewritten to. Audit the result before committing it
# (see site/README.md).
set -euo pipefail

DEMO_REPO=${DEMO_REPO:-$HOME/proj/toolreader-demo}
SESSIONS=${SESSIONS:-$HOME/.codex/sessions/2026/10/01}
ROLLOUTS=(
  rollout-2026-10-01T15-20-35-01a0f79f-bc4b-7501-b52d-6dc8cf2809b3.jsonl # failed to commit
  rollout-2026-10-01T15-22-54-01a0f7a1-d93a-77b1-b192-7c9ad47b7439.jsonl # the four commits
)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/site/demo/ledger.json
TMP=$(mktemp -d /tmp/toolreader-demo.XXXXXX)
# KEEP=1 keeps the curated copies, e.g. to point the viewer at them for screenshots.
trap '[ -n "${KEEP:-}" ] || rm -rf "$TMP"' EXIT

git clone -q --no-local "$DEMO_REPO" "$TMP/wordfreq"
git -C "$TMP/wordfreq" remote remove origin
mkdir -p "$TMP/codex/sessions/2026/10/01"
for f in "${ROLLOUTS[@]}"; do cp "$SESSIONS/$f" "$TMP/codex/sessions/2026/10/01/"; done

# Curate the copies: neutral paths, and nothing from the developer's own setup.
python3 - "$TMP"/codex/sessions/2026/10/01/*.jsonl <<'PY'
import json, os, sys

SKILL = ".agents/skills/unslop/SKILL.md"
TEXT = [
    (os.path.expanduser("~/proj/toolreader-demo"), "/work/wordfreq"),
    (os.path.expanduser("~"), "/home/dev"),
    # A setting from the developer's npmrc, printed by every `npm test`.
    ('npm warn Unknown user config "minimum-release-age". This will stop working in the next'
     " major version of npm. See `npm help npmrc` for supported config options.\n", ""),
    # A personal skill: its read is dropped below, and so is the mention.
    (" I’m applying the unslop skill to keep the wording clear.", ""),
    (" I’m using the unslop skill to keep the text clear and simple.", ""),
    ("alex  staff", "dev   staff"),
]

def scrub(v):
    if isinstance(v, str):
        for a, b in TEXT:
            v = v.replace(a, b)
        return v
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, dict):
        return {scrub(k): scrub(x) for k, x in v.items()}
    return v

for path in sys.argv[1:]:
    lines = [json.loads(l) for l in open(path, encoding="utf-8")]
    p = lambda r: r.get("payload") or {}
    # The call that read the skill file, its output and its completed item.
    calls = {p(r).get("call_id") for r in lines
             if p(r).get("type") == "custom_tool_call" and SKILL in json.dumps(p(r))}
    keep = [r for r in lines
            if p(r).get("call_id") not in calls
            and not (p(r).get("type") == "item_completed" and SKILL in json.dumps(p(r)))]
    with open(path, "w", encoding="utf-8") as f:
        for r in keep:
            f.write(json.dumps(scrub(r), ensure_ascii=False, separators=(",", ":")) + "\n")
PY

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

# The page's inlined range (already through `publicRange`) is the demo's data.
python3 - "$TMP/site/index.html" "$OUT" <<'PY'
import json, re, sys
html = open(sys.argv[1], encoding="utf-8").read()
data = re.search(r'<script type="application/json" id="ledger-data">(.*?)</script>', html, re.S)
json.dump(json.loads(data.group(1)), open(sys.argv[2], "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
echo "$OUT"
[ -z "${KEEP:-}" ] || echo "kept $TMP"
