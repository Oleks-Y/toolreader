# toolreader website

Static, no framework: `index.html`, `style.css` and `img/` (screenshots, WebP), plus a demo.

```bash
pnpm run site:build    # → site/dist (index.html, style.css, img/, demo/index.html)
```

`scripts/site.ts` copies the page, inserts the two `docs/ci/` workflows where `index.html` has
`<!--ci:NAME-->`, and builds `demo/index.html` the way `toolreader ledger site` does: the current
site template (`dist/site/index.html`) filled with `demo/ledger.json`. To preview, serve `site/dist`
on localhost, e.g. `python3 -m http.server 4785 --bind 127.0.0.1 --directory site/dist`.
`demo/index.html` also opens from `file://`.

The landing page runs no scripts and loads nothing from other origins (its CSP allows only its own
stylesheet and images). The demo is the ledger page with its own CSP: one inline script, nothing
loaded.

## The demo data

`demo/ledger.json` is the public range of a small repo (wordfreq, a Node.js CLI) whose four commits
`codex exec` made. `demo/make-data.sh DEMO_REPO` regenerates it; run it only when the ledger format
changes. It clones the repo, and `demo/curate.py` copies the rollouts that ran in it into a temp
dir and rewrites the copies:

- the repo's path becomes `/work/wordfreq`, and the local user name becomes `dev`;
- tool calls that touch a path outside the repo are dropped;
- `npm warn` lines and sentences in agent messages that mention skills are removed.

Then the script syncs and builds the page in a Docker container where the repo really is at
`/work/wordfreq`. It never writes to the demo repo or to `~/.codex`.

The curation removes only what it knows. The privacy gate (`scripts/privacyGate.ts`, rules in
`src/core/privacy.ts`) decides what may be published. It runs before `make-data.sh` replaces
`ledger.json` and before `pnpm run site:build` builds anything. It fails on:

- absolute or `~/` paths outside `/work/wordfreq`, except the shell and `env` binaries;
- emails other than the two demo identities;
- URLs not on example.com or example.org;
- this machine's own values, read at run time: `$HOME`, `$USER`, git `user.email` and `user.name`,
  the hostname, and the names under `~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills` and
  `~/proj` that aren't ordinary English words.

It prints the path of each string it rejects. To check data by hand, run
`node scripts/privacyGate.ts site/demo/ledger.json`.

## Deploying

Nothing is set up. The output is plain files: `site/dist` is about 11.6 MB, almost all of it
`demo/index.html` (the viewer, inlined; about 2 MB gzipped).

- **GitHub Pages:** needs a public repo on the free plan, and toolreader is private. Use a separate
  public repo that holds only the built `site/dist`.
- **Vercel, Netlify or Cloudflare Pages:** deploy from this private repo, either by uploading the
  built `site/dist` from a machine or CI, or by letting the host build it (build command
  `pnpm run site:build`, output directory `site/dist`, Node 24; not tried yet).
