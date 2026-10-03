# Layered attribution per (commit, file):
#   actor evidence  = threads whose recorded actions edited the path (edit tool `files`, or a shell
#                     command naming the path) after the previous commit of that path, before this commit
#   content evidence = committed blob equals a checkpoint blob of a turn of that same actor ("verified")
# classes: verified (1 actor + content), actor (1 actor, content not proven), shared (>1 actor),
#          worktree-only (no actor; a checkpoint shows it appeared during some turn), untracked (nothing)
import subprocess, base64, collections, sys, json, urllib.request, re, datetime
repo, rng, api = sys.argv[1], sys.argv[2], "http://127.0.0.1:4777"
def git(*a): return subprocess.run(["git","-C",repo,*a],capture_output=True,text=True,check=True).stdout
def ts(iso): return datetime.datetime.fromisoformat(iso.replace("Z","+00:00")).timestamp()
refs = collections.defaultdict(list)
for line in git("for-each-ref","--format=%(refname) %(objectname) %(creatordate:unix)","refs/t3/checkpoints/").splitlines():
    ref, sha, t = line.split(); p = ref.split("/")
    refs[base64.b64decode(p[3]+"==").decode()].append((int(p[5]), sha, int(t)))
blobturn = collections.defaultdict(set)   # (path, blob) -> {thread}
appeared = collections.defaultdict(set)   # path -> {thread} whose turn diff changed it
for th, turns in refs.items():
    turns.sort()
    for (_, s0, _), (_, s1, _) in zip(turns, turns[1:]):
        for l in git("diff-tree","-r","--no-renames",s0,s1).splitlines():
            meta, path = l.split("\t",1); blobturn[(path, meta.split()[3])].add(th[:8]); appeared[path].add(th[:8])
edits = collections.defaultdict(list)     # path -> [(time, thread, how)]
for th in refs:
    try: d = json.load(urllib.request.urlopen(f"{api}/api/threads/{th}"))
    except Exception as e: continue
    for a in d["entries"]:
        if a["type"] != "action": continue
        t = ts(a["at"])
        for f in a.get("files") or []:
            edits[f["path"]].append((t, th[:8], "diff" if f.get("diff") else "files"))
        cmd = a.get("command") or ""
        if a["kind"] in ("edit","run","build","tool") and cmd:
            for path in re.findall(r"[\w./-]+\.\w+", cmd):
                if re.search(r"(?<![0-9&])>(?!&|\s*/dev/null)|sed -i|\btee\b|\bcp\b|\bmv\b|write_text|\.write\(", cmd) and path in cmd:
                    edits[path.split("toolreader/")[-1]].append((t, th[:8], "shell"))
last_commit_of = {}
cls_total = collections.Counter(); per_commit = []
for c in git("rev-list","--reverse",rng).split():
    ct = int(git("log","-1","--format=%ct",c)); subj = git("log","-1","--format=%s",c).strip()
    out = []
    for l in git("diff-tree","-r","--no-renames",c+"^",c).splitlines():
        meta, path = l.split("\t",1); blob = meta.split()[3]
        prev = git("log","-1","--format=%ct",c+"^","--",path).strip()
        since = int(prev) if prev else 0
        actors = sorted({th for t, th, _ in edits.get(path, []) if since - 60 <= t <= ct + 5})
        if len(actors) == 1:
            k = "verified" if actors[0] in blobturn.get((path, blob), set()) else "actor"
        elif actors: k = "shared"
        else: k = "worktree-only" if appeared.get(path) else "untracked"
        out.append((path, k, actors)); last_commit_of[path] = ct
    cls_total.update(k for _, k, _ in out)
    print(f"{c[:8]} {dict(collections.Counter(k for _,k,_ in out))} {subj[:55]}")
    for p, k, a in out:
        if k not in ("verified",): print(f"      {k:13} {p} {a}")
print("TOTAL", dict(cls_total))
