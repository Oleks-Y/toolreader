#!/bin/sh
# The packaged CLI end to end, as a team installs it: `npm pack`, installed into a temp directory,
# then a backend on a throwaway Postgres, an upload through it, the outbox while it is down, and
# the git hooks in a temp repo. Everything lives under a temp HOME; the Postgres container and
# the backend are stopped by the id and PID this script got when it started them.
# CI runs it after the build. Locally: `vp run build && sh scripts/smoke.sh` (needs Docker).
set -eu
# A backend, a collector or a trace file set in your shell would take the test's records and spans
# (or be overwritten): never theirs, from the first CLI call on.
unset TOOLREADER_BACKEND_URL TOOLREADER_BACKEND_TOKEN TOOLREADER_BACKEND_WORKSPACE
unset TOOLREADER_DATABASE_URL TOOLREADER_TRACE OTEL_TRACES_EXPORTER OTEL_EXPORTER_OTLP_ENDPOINT
unset OTEL_EXPORTER_OTLP_TRACES_ENDPOINT

image=$(sed -n 's/^const IMAGE = "\(.*\)";$/\1/p' src/server/backend/testPostgres.ts)
version=$(node -p 'require("./package.json").version')
tmp=$(cd "$(mktemp -d)" && pwd -P)
cid=""
backend=""
cleanup() {
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

# From here on the CLI sees only the temp home: config, outbox, log, sessions.
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
start_backend() {
  TOOLREADER_DATABASE_URL="$db" "$tr" --log-level error backend serve --port "$port" \
    > "$tmp/backend.log" 2>&1 &
  backend=$!
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$port/v1/health" > /dev/null && return
    sleep 0.5
  done
  cat "$tmp/backend.log" >&2
  exit 1
}
start_backend
token=$(TOOLREADER_DATABASE_URL="$db" "$tr" --log-level error backend token create \
  --workspace smoke --name ci 2> /dev/null)
printf '{"backend":{"url":"http://127.0.0.1:%s","token":"%s","workspace":"smoke"}}\n' \
  "$port" "$token" > "$HOME/.toolreader/config.json"

# A repo with an origin (the backend names repos owner/name) and a Codex session that ran in it.
repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" remote add origin https://github.com/acme/smoke.git
git -C "$repo" commit -q --allow-empty -m one
rollouts="$CODEX_HOME/sessions/2026/01/01"
mkdir -p "$rollouts"
at=2026-01-01T10:00:00Z
cat > "$rollouts/rollout-2026-01-01T10-00-00-smoke-1.jsonl" << EOF
{"timestamp":"$at","type":"session_meta","payload":{"id":"smoke-1","timestamp":"$at","cwd":"$repo","originator":"codex_exec"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"say hi"}]}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}
EOF

put() { "$tr" --log-level error checkpoint put --session codex:smoke-1 "$@" 2>&1; }
expect "inserted" "$(put)"
expect "exists" "$(put)"

# Backend down: the record waits in the outbox, and the next run sends it first.
kill "$backend"
wait "$backend" 2> /dev/null || true
expect "queued" "$(put --no-outputs)"
test "$(find "$HOME/.toolreader/outbox" -name "*.json" | wc -l)" -eq 1
start_backend
expect "from the outbox" "$(put --no-outputs)"
test "$(find "$HOME/.toolreader/outbox" -name "*.json" | wc -l)" -eq 0

# Hooks: post-rewrite sends an amend's old -> new pair in the background.
expect "Set toolreader.checkpoints=true" "$("$tr" --log-level error checkpoint hook install --repo "$repo")"
git -C "$repo" commit -q --amend --allow-empty -m one-amended
for _ in $(seq 60); do
  grep -q "1 rewritten commit inserted" "$HOME/.toolreader/checkpoint.log" 2> /dev/null && break
  sleep 0.5
done
expect "1 rewritten commit inserted" "$(cat "$HOME/.toolreader/checkpoint.log")"
# pre-push: a commit that names the session in its trailer, pushed; the hook's background job
# collects it once the push has landed, and uploads the session's record.
git init -q --bare "$tmp/origin.git"
git -C "$repo" config remote.origin.pushurl "$tmp/origin.git"
# A second session, working after the amended commit: what the next commit's link window holds.
sleep 1
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$rollouts/rollout-2026-01-01T10-00-01-smoke-2.jsonl" << EOF
{"timestamp":"$now","type":"session_meta","payload":{"id":"smoke-2","timestamp":"$now","cwd":"$repo","originator":"codex_exec"}}
{"timestamp":"$now","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"$now","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"add two"}]}}}
{"timestamp":"$now","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"c1","command":["/bin/sh","-lc","echo two"],"cwd":"$repo","status":"completed","aggregated_output":"two\n","exit_code":0}}}
{"timestamp":"$now","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}
EOF
sleep 1
git -C "$repo" commit -q --allow-empty -m two -m "Agent-Session: codex:smoke-2"
git -C "$repo" push -q origin HEAD:main
for _ in $(seq 60); do
  grep -q "(by trailer)" "$HOME/.toolreader/checkpoint.log" 2> /dev/null && break
  sleep 0.5
done
log=$(cat "$HOME/.toolreader/checkpoint.log")
expect "inserted  (by trailer)" "$log"
if printf '%s\n' "$log" | grep -q "✗"; then
  printf 'smoke: a hook failed:\n%s\n' "$log" >&2
  exit 1
fi
echo "smoke: ok (toolreader v$version)"
