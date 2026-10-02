# Prototype: explain each commit's file changes using T3 turn checkpoints (refs/t3/checkpoints/<b64 thread>/turn/<n>).
# A changed file is "exact" if its committed blob equals what some turn left in the worktree,
# "touched" if some turn changed that path but the committed content matches no checkpoint,
# and "unexplained" if no recorded turn changed that path at all.
import subprocess, base64, collections, sys, json
repo, rng = sys.argv[1], sys.argv[2]
def git(*a): return subprocess.run(["git","-C",repo,*a],capture_output=True,text=True,check=True).stdout
refs = collections.defaultdict(list)
for line in git("for-each-ref","--format=%(refname) %(objectname) %(creatordate:unix)","refs/t3/checkpoints/").splitlines():
    ref, sha, t = line.split()
    parts = ref.split("/")
    thread = base64.b64decode(parts[3] + "==").decode()
    refs[thread].append((int(parts[5]), sha, int(t)))
idx = collections.defaultdict(list)    # (path, blob) -> [(thread, turn, time)]
touched = collections.defaultdict(list) # path -> [(thread, turn, time)]
for thread, turns in refs.items():
    turns.sort()
    for (n0, s0, _), (n1, s1, t1) in zip(turns, turns[1:]):
        for l in git("diff-tree","-r","--no-renames",s0,s1).splitlines():
            meta, path = l.split("\t", 1)
            newblob = meta.split()[3]
            idx[(path, newblob)].append((thread[:8], n1, t1))
            touched[path].append((thread[:8], n1, t1))
rows = []
for c in git("rev-list","--reverse",rng).split():
    subj = git("log","-1","--format=%s",c).strip()
    ctime = int(git("log","-1","--format=%ct",c))
    files = []
    for l in git("diff-tree","-r","--no-renames","--root",c).splitlines()[1:] if False else git("diff-tree","-r","--no-renames",c+"^",c).splitlines():
        meta, path = l.split("\t", 1)
        newblob = meta.split()[3]
        hits = [h for h in idx.get((path, newblob), []) if h[2] <= ctime + 120]
        if hits:
            files.append((path, "exact", sorted({h[0] for h in hits})))
        else:
            near = [h for h in touched.get(path, []) if ctime - 86400 <= h[2] <= ctime + 3600]
            files.append((path, "touched" if near else "unexplained", sorted({h[0] for h in near})))
    rows.append((c[:8], subj, files))
summary = collections.Counter()
for c, subj, files in rows:
    kinds = collections.Counter(k for _, k, _ in files)
    summary.update(kinds)
    threads = sorted({t for _, _, ts in files for t in ts})
    print(f"{c} {dict(kinds)} threads={threads} {subj[:60]}")
    for p, k, ts in files:
        if k != "exact": print(f"      {k:11} {p} {ts}")
print("TOTAL", dict(summary), "threads with checkpoints:", {t[:8]: len(v) for t, v in refs.items()})
