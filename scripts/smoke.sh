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
TOOLREADER_DATABASE_URL="$db" "$tr" --log-level error backend serve --port "$port" \
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

# A Codex session that wrote store.ts a minute ago, committed it, and declared the commit its own.
rollouts="$CODEX_HOME/sessions/2026/01/01"
mkdir -p "$rollouts"
at=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ)
printf 'export function saveThread(record) {\n  return store.put(record.id, record);\n}\n' > "$repo/store.ts"
git -C "$repo" add store.ts
git -C "$repo" commit -q -m "feat: store"
sha=$(git -C "$repo" rev-parse HEAD)
cat > "$rollouts/rollout-2026-01-01T10-00-00-smoke-1.jsonl" << EOF
{"timestamp":"$at","type":"session_meta","payload":{"id":"smoke-1","timestamp":"$at","cwd":"$repo","originator":"codex_exec"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"add the store"}]}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"FileChange","id":"f1","status":"completed","changes":{"$repo/store.ts":{"type":"add","content":"export function saveThread(record) {\\n  return store.put(record.id, record);\\n}\\n"}}}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"d1","command":["/bin/sh","-lc","toolreader history link --sha HEAD --note 'the store'"],"cwd":"$repo","status":"completed","aggregated_output":"history link: $sha for HEAD","exit_code":0}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}
EOF

expect "declared: 1 turn" \
  "$("$tr" --log-level error history sync --repo "$repo" --range HEAD~1..HEAD --dry-run 2>&1)"

# Opted in, a push sends it in the background.
expect "Set toolreader.history=true" "$("$tr" --log-level error history hook install --repo "$repo")"
git -C "$repo" push -q origin HEAD:main
for _ in $(seq 60); do
  grep -q "thread sent\|threads sent" "$HOME/.toolreader/history.log" 2> /dev/null && break
  sleep 0.5
done
log=$(cat "$HOME/.toolreader/history.log")
expect "acme/smoke: 1 thread sent" "$log"

# A QA subagent it delegated afterwards: it ran outside the repo, changed nothing and made no
# commit. The parent's Stop hook sends it, with no git push involved.
cat > "$rollouts/rollout-2026-01-01T10-30-00-smoke-qa.jsonl" << EOF
{"timestamp":"$at","type":"session_meta","payload":{"id":"smoke-qa","timestamp":"$at","cwd":"$tmp","originator":"codex_exec","source":{"subagent":{"other":"qa"}},"parent_thread_id":"smoke-1"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_started","turn_id":"q1"}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"q1","item":{"type":"UserMessage","id":"q1","content":[{"type":"text","text":"check staging"}]}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"item_completed","turn_id":"q1","item":{"type":"CommandExecution","id":"q2","command":["/bin/sh","-lc","curl -sf https://staging.example.test/health"],"cwd":"$tmp","status":"completed","aggregated_output":"ok","exit_code":0}}}
{"timestamp":"$at","type":"event_msg","payload":{"type":"task_complete","turn_id":"q1"}}
EOF
printf '{"session_id":"smoke-1","cwd":"%s","hook_event_name":"Stop"}' "$repo" |
  "$tr" --log-level error history capture
for _ in $(seq 60); do
  grep -q "capture smoke-1" "$HOME/.toolreader/history.log" 2> /dev/null && break
  sleep 0.5
done
log=$(cat "$HOME/.toolreader/history.log")
expect "codex:smoke-qa (subagent of codex:smoke-1)" "$log"
expect "1 sent, 1 unchanged" "$log"
expect '"parent":"codex:smoke-1"' \
  "$("$tr" --log-level error history sql "SELECT parent FROM agent_threads WHERE id = 'codex:smoke-qa'" 2> /dev/null)"
expect "Delivery: nothing pending" "$("$tr" --log-level error history status --repo "$repo" --check)"
if printf '%s\n' "$log" | grep -q "✗"; then
  printf 'smoke: a hook failed:\n%s\n' "$log" >&2
  exit 1
fi
echo "smoke: ok (toolreader v$version)"
