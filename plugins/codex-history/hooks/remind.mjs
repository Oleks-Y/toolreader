// The team-approved CLI owns hook input validation and reminder behavior.
import * as NodeChildProcess from "node:child_process";
const result = NodeChildProcess.spawnSync("toolreader", ["history", "hook-event"], {
  stdio: "inherit",
});
if (result.error)
  process.stderr.write(
    "Codex history helper is missing. Complete plugin setup and run the history skill explicitly.\n",
  );
process.exitCode = result.status ?? 1;
