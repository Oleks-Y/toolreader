#!/bin/sh
# The packaged CLI end to end, as a team installs it: `npm pack`, installed into a temp directory,
# then a backend on a throwaway Postgres, and a repo that opted in: a Codex session writes a file,
# commits and declares it, the push's background job sends the history, and the session's Stop
# hook later sends the QA subagent it delegated, which made no commit. Everything
# lives under a temp HOME; the Postgres container and the backend are stopped by the id and PID
# this script got when it started them.
# CI runs it after the build. Locally: `vp run build && sh scripts/smoke.sh` (needs Docker).
set -eu
# A backend set in your shell would take the test's records: never yours.
unset TOOLREADER_BACKEND_URL TOOLREADER_BACKEND_TOKEN TOOLREADER_BACKEND_WORKSPACE
unset TOOLREADER_DATABASE_URL
# Nor may your git or XDG config: no hooks path, signing, aliases or credential helpers of yours.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset XDG_CONFIG_HOME

image=$(sed -n 's/^const IMAGE = "\(.*\)";$/\1/p' src/server/backend/testPostgres.ts)
version=$(node -p 'require("./package.json").version')
tmp=$(cd "$(mktemp -d)" && pwd -P)
cid=""
backend=""
# A capture job still running (its pid is in its lock file, which it writes itself): stopped by that
# pid alone. The pre-push job leaves no pid; the script waits for its log line before going on.
stop_captures() {
  for lock in "$tmp"/home/.toolreader/capture-*.lock; do
    [ -f "$lock" ] || continue
    pid=$(cat "$lock" 2> /dev/null || true)
    case "$pid" in '' | *[!0-9]*) continue ;; esac
    kill "$pid" 2> /dev/null || true
  done
}
cleanup() {
  stop_captures
  if [ -n "$backend" ]; then kill "$backend" 2>/dev/null || true; fi
  if [ -n "$cid" ]; then docker rm -f "$cid" > /dev/null; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

expect() {
  printf '%s\n' "$2" | grep -q -- "$1" || {
    printf 'smoke: expected "%s" in:\n%s\n' "$1" "$2" >&2
    exit 1
  }
}

npm pack --ignore-scripts --silent --pack-destination "$tmp" > /dev/null
mkdir "$tmp/install"
(cd "$tmp/install" && npm init -y > /dev/null &&
  npm install --no-audit --no-fund --silent "$tmp/toolreader-$version.tgz")
tr="$tmp/install/node_modules/.bin/toolreader"
test "$("$tr" --version)" = "toolreader v$version"

# From here on the CLI sees only the temp home: config, log, sessions.
export HOME="$tmp/home" CODEX_HOME="$tmp/home/.codex" CLAUDE_CONFIG_DIR="$tmp/home/.claude"
export T3_DB="$tmp/none.sqlite"
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.test
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.test
mkdir -p "$HOME/.toolreader"

cid=$(docker run --rm -d -e POSTGRES_PASSWORD=smoke -p 127.0.0.1::5432 "$image")
pg_port=$(docker port "$cid" 5432/tcp | head -n 1 | sed 's/.*://')
for _ in $(seq 60); do
  docker exec "$cid" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 && break
  sleep 1
done
db="postgres://postgres:smoke@127.0.0.1:$pg_port/postgres"
port=$((20000 + $$ % 20000))
TOOLREADER_DATABASE_URL="$db" TOOLREADER_CODEX_ARCHIVE_DIR="$tmp/artifacts" "$tr" --log-level error backend serve --port "$port" \
  > "$tmp/backend.log" 2>&1 &
backend=$!
for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:$port/v1/health" > /dev/null && break
  sleep 0.5
done
token=$(TOOLREADER_DATABASE_URL="$db" "$tr" --log-level error backend token create \
  --workspace smoke --name ci 2> /dev/null)
printf '{"backend":{"url":"http://127.0.0.1:%s","token":"%s","workspace":"smoke"}}\n' \
  "$port" "$token" > "$HOME/.toolreader/config.json"

# A repo with an origin (the backend names repos owner/name), pushing to a local bare repo.
repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" remote add origin https://github.com/acme/smoke.git
git init -q --bare "$tmp/origin.git"
git -C "$repo" config remote.origin.pushurl "$tmp/origin.git"
git -C "$repo" commit -q --allow-empty -m one
git -C "$repo" push -q origin HEAD:main

# A selected synthetic local Codex session. Its commit link is written only after both copies sync.
rollouts="$CODEX_HOME/sessions/2026/01/01"
mkdir -p "$rollouts"
repo_id="11111111-1111-4111-8111-111111111111"
at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'export const stored = true;\n' > "$repo/store.ts"
git -C "$repo" add store.ts
git -C "$repo" commit -q -m "feat: store"
sha=$(git -C "$repo" rev-parse HEAD)
cat > "$rollouts/rollout-2026-01-01T10-00-00-$repo_id.jsonl" << EOF
{"timestamp":"$at","type":"session_meta","payload":{"id":"$repo_id","timestamp":"$at","cwd":"$repo","originator":"codex_exec"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"add the store"}]}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}
EOF
expect "Filtered $repo_id"   "$("$tr" --log-level error history sync --session "$repo_id" --repo "$repo" --sha "$sha" 2>&1)"
expect "codex:$repo_id"   "$("$tr" --log-level error history sql "SELECT id FROM agent_threads WHERE id = 'codex:$repo_id'" 2>&1)"
expect '"event_type":"session_meta"'   "$("$tr" --log-level error history sql "SELECT event_type FROM agent_history_events WHERE session_id = '$repo_id' ORDER BY seq LIMIT 1" 2>&1)"
expect "\"sha\":\"$sha\""   "$("$tr" --log-level error history sql "SELECT sha FROM agent_codex_commit_links WHERE session_id = '$repo_id'" 2>&1)"
echo "smoke: ok (toolreader v$version)"
