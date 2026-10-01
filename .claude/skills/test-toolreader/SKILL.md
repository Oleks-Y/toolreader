---
name: test-toolreader
description: Launch, smoke-test and stop the toolreader viewer against a safe snapshot of T3's database, then check API responses and the UI. Use when an agent needs to run toolreader locally, verify a change to normalization, the HTTP API or the web UI, or hand a running instance to the developer.
---

# Test toolreader

Run everything from the repository root. Never point a test run at `~/.t3/userdata/state.sqlite` with anything but toolreader's read-only open, and never write to it.

## 1. Snapshot the data

Use a snapshot so the run is reproducible and the live database can't be touched:

```bash
rm -rf .t3 && mkdir .t3
node -e "new (require('node:sqlite').DatabaseSync)(process.env.HOME + '/.t3/userdata/state.sqlite', { readOnly: true }).exec(\"VACUUM INTO '.t3/state.sqlite'\")"
```

Skip this step only when the developer explicitly wants live data. In that case run without `T3_DB`; the server still opens the live database read-only.

## 2. Pick a port and start

Port 4777 is the developer's default and may already be in use. Use another port for test runs:

```bash
lsof -nP -iTCP:4778 -sTCP:LISTEN   # must print nothing
vp build && T3_DB=$PWD/.t3/state.sqlite PORT=4778 node src/server/bin.ts
```

Run the server in the background and record its PID **at spawn**. Wait for the `toolreader → http://127.0.0.1:<port>` log line, not a sleep.

For UI work with hot reload, run `PORT=4778 vp run dev` instead, and open the Vite URL it prints. Vite proxies `/api` to the server port.

## 3. Smoke-test the API

```bash
curl -s localhost:4778/api/threads | jq 'length, .[0]'
ID=$(curl -s localhost:4778/api/threads | jq -r '.[0].id')
curl -s localhost:4778/api/threads/$ID | jq '{t: .thread.title, entries: (.entries|length), actions: .thread.actionCount}'
curl -s localhost:4778/api/threads/$ID/head
curl -s localhost:4778/api/threads/nope -w ' %{http_code}\n'   # {"_tag":"ThreadNotFound",…} 404
```

For a normalization change, compare titles on a thread with many actions, for example:

```bash
curl -s localhost:4778/api/threads/$ID | jq -r '.entries[] | select(.type=="action") | "\(.status)\t\(.kind)\t\(.title)"' | head -80
```

Do not call `POST /api/labels` unless the developer asks: it runs real `codex exec` and spends tokens. Its behavior is covered by `src/server/Labeler.test.ts` with a fake binary.

## 4. Check the UI

Ask the developer before opening a browser. If you're running inside T3 Code and they agree, use the T3 preview tools (`preview_open` on `http://127.0.0.1:4778`, then `preview_snapshot` or `device_screenshot`). Check that:

- the sessions list groups threads by project and marks running ones;
- opening a thread shows the swimlane and the turn → phase → action tree;
- toggling a kind switch hides those rows and dims their swimlane lane;
- dragging across the swimlane filters the tree, and clicking a dot scrolls to its row.

## 5. Stop

Stop only the PID you recorded in step 2. If you lost it, find the owner of _your_ port with `lsof -nP -iTCP:4778 -sTCP:LISTEN` and confirm its cwd is this repo (`lsof -a -p <pid> -d cwd`) before killing it. Never kill by name pattern.

When the developer will keep inspecting the result, leave the server running and tell them the URL and PID instead.
