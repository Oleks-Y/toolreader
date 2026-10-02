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
`codex exec` made. `demo/make-data.sh` regenerates it; run it only when the ledger format changes.
It clones the demo repo and copies its rollouts into a temp dir, rewrites the copies (the repo path
becomes `/work/wordfreq`, the home directory `/home/dev`, and a skill file read, a personal npm
config warning and a username in `ls` output are removed), then syncs and builds the page in a
Docker container where the repo really is at `/work/wordfreq`. It never writes to the demo repo or
to `~/.codex`.

Before committing new data, read every string in it:

```bash
grep -n -i -E 'users/|/home/|\.codex|\.agents|skill|npmrc|account|token|secret|password|model|@' site/demo/ledger.json
jq -r '.. | strings' site/demo/ledger.json | less
```

## Deploying

Nothing is set up. The output is plain files: `site/dist` is about 11.6 MB, almost all of it
`demo/index.html` (the viewer, inlined; about 2 MB gzipped).

- **GitHub Pages:** needs a public repo on the free plan, and toolreader is private. Use a separate
  public repo that holds only the built `site/dist`.
- **Vercel, Netlify or Cloudflare Pages:** deploy from this private repo, either by uploading the
  built `site/dist` from a machine or CI, or by letting the host build it (build command
  `pnpm run site:build`, output directory `site/dist`, Node 24; not tried yet).
