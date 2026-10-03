"""Copies a demo repo's Codex rollouts and curates the copies for the public demo.

    python3 curate.py REPO CODEX_HOME OUT

Copies every rollout under CODEX_HOME/{sessions,archived_sessions} whose session ran in REPO to
OUT/sessions/, then rewrites the copies:
- REPO's path becomes /work/wordfreq, and the local user name (as in `ls -l` output) becomes dev;
- tool calls that touch a path outside the repo (an agent reading its own setup) are dropped,
  with their output and their completed item;
- `npm warn` lines, which print the local npm config, are removed, and so are sentences in the
  agent's messages that mention skills, which are its local setup.

This only removes what it knows. scripts/privacyGate.ts checks the result.
"""

import json
import os
import re
import shutil
import sys

WORK = "/work/wordfreq"
SYSTEM = ("/bin/", "/usr/bin/", "/dev/null")
# Same shape as scripts/privacy.ts: a path starts the text or follows a separator.
PATH = re.compile(r"""(?<![^\s"'`=(:,\[{<>|;&])~?/[\w.-]+(?:/[\w.-]+)*""")
NPM_WARN = re.compile(r"(?m)^npm warn .*\n?")
SKILL_SENTENCE = re.compile(r"\s*[^.!?\n]*\bskills?\b[^.!?\n]*[.!?]", re.I)


def rollouts(codex_home, repo):
    for sub in ("sessions", "archived_sessions"):
        for d, _, names in os.walk(os.path.join(codex_home, sub)):
            for n in sorted(names):
                if n.startswith("rollout-") and n.endswith(".jsonl"):
                    f = os.path.join(d, n)
                    with open(f, encoding="utf-8") as fh:
                        first = json.loads(fh.readline() or "{}")
                    if os.path.realpath((first.get("payload") or {}).get("cwd") or "/") == repo:
                        yield f


def main(repo, codex_home, out):
    repo = os.path.realpath(repo)
    user = os.environ.get("USER", "")
    user_re = re.compile(rf"(?<![\w-]){re.escape(user)}(?![\w-])") if len(user) >= 2 else None

    def text(s):
        s = s.replace(repo, WORK)
        if user_re:
            s = user_re.sub("dev".ljust(len(user)), s)
        return NPM_WARN.sub("", s)

    def scrub(v, f=text):
        if isinstance(v, str):
            return f(v)
        if isinstance(v, list):
            return [scrub(x, f) for x in v]
        if isinstance(v, dict):
            return {scrub(k, f): scrub(x, f) for k, x in v.items()}
        return v

    def is_message(r):
        p = r.get("payload") or {}
        return p.get("type") in ("message", "agent_message") or (p.get("item") or {}).get("type") == "AgentMessage"

    def strings(v):
        if isinstance(v, str):
            yield v
        elif isinstance(v, list):
            for x in v:
                yield from strings(x)
        elif isinstance(v, dict):
            for k, x in v.items():
                yield k
                yield from strings(x)

    def outside(v):
        for s in strings(v):
            for m in PATH.finditer(s):
                p = m.group(0)
                if not (p == WORK or p.startswith(WORK + "/") or p.startswith(SYSTEM)):
                    return True
        return False

    dest = os.path.join(out, "sessions")
    os.makedirs(dest, exist_ok=True)
    found = list(rollouts(codex_home, repo))
    if not found:
        sys.exit(f"no rollouts ran in {repo}")
    for src in found:
        records = [scrub(json.loads(line)) for line in open(src, encoding="utf-8")]
        records = [scrub(r, lambda s: SKILL_SENTENCE.sub("", s)) if is_message(r) else r for r in records]
        p = lambda r: r.get("payload") or {}
        calls = {p(r).get("call_id") for r in records
                 if p(r).get("type") == "custom_tool_call" and outside(p(r))}
        keep = [r for r in records
                if not (p(r).get("call_id") in calls
                        or (p(r).get("type") == "item_completed"
                            and (p(r).get("item") or {}).get("type") not in ("AgentMessage", "UserMessage")
                            and outside(p(r).get("item"))))]
        with open(os.path.join(dest, os.path.basename(src)), "w", encoding="utf-8") as f:
            for r in keep:
                # Compact, as Codex writes it: src/core/rollout.ts scans for `"payload":{"type":"`.
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"{os.path.basename(src)}: kept {len(keep)} of {len(records)} records")


if __name__ == "__main__":
    main(*sys.argv[1:4])
