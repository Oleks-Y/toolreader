#!/usr/bin/env bash
# The ledger action (action.yml): installs toolreader, then runs `ledger sync` or `ledger site`.
# Inputs come as INPUT_* variables, so it also runs outside Actions: RUNNER_TEMP and the
# GITHUB_* files are optional.
set -euo pipefail

temp=${RUNNER_TEMP:-$(mktemp -d)}
package=${INPUT_PACKAGE:-$(dirname "$0")/..}
repo=${INPUT_REPO:-.}

# Install from a tarball, or pack a toolreader checkout first (its prepack builds it).
if [ -d "$package" ]; then
  echo "::group::Build toolreader from $package"
  packed=$(mktemp -d "$temp/toolreader-pack.XXXX")
  (cd "$package" && corepack pnpm install --frozen-lockfile && npm pack --pack-destination "$packed")
  echo "::endgroup::"
  tarball=$(echo "$packed"/toolreader-*.tgz)
else
  tarball=$(cd "$(dirname "$package")" && pwd)/$(basename "$package")
fi
prefix="$temp/toolreader-install"
npm install --prefix "$prefix" --no-audit --no-fund --loglevel error "$tarball"
toolreader="$prefix/node_modules/.bin/toolreader"

# The ledger commit needs an identity; CI runners have none.
if [ -z "$(git -C "$repo" config user.name || true)" ]; then
  export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
  export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
  export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
fi

args=(--repo "$repo")
[ -n "${INPUT_RANGE:-}" ] && args+=(--range "$INPUT_RANGE")
# Word-split on purpose: `--session a --session b`.
read -r -a extra <<<"${INPUT_ARGS:-}"

case "${INPUT_COMMAND:-}" in
  sync)
    [ -n "${INPUT_CODEX_HOME:-}" ] && args+=(--codex-home "$INPUT_CODEX_HOME")
    [ -n "${INPUT_MAX_OUTPUT:-}" ] && args+=(--max-output "$INPUT_MAX_OUTPUT")
    [ "${INPUT_PUSH:-false}" = true ] && args+=(--push)
    "$toolreader" ledger sync "${args[@]}" ${extra[@]+"${extra[@]}"}
    ;;
  site)
    # A fresh checkout has no local agent-ledger: take origin's. An existing one is left alone.
    if ! git -C "$repo" rev-parse --verify --quiet refs/heads/agent-ledger >/dev/null; then
      if git -C "$repo" ls-remote --exit-code origin refs/heads/agent-ledger >/dev/null; then
        git -C "$repo" fetch --quiet --no-tags origin refs/heads/agent-ledger:refs/heads/agent-ledger
      else
        echo "::notice::origin has no agent-ledger branch yet; the page lists commits without history."
      fi
    fi
    "$toolreader" ledger site "${args[@]}" --out "${INPUT_OUT:-ledger-site}" ${extra[@]+"${extra[@]}"}
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        echo "### Agent history"
        echo
        echo '```'
        "$toolreader" ledger show "${args[@]}"
        echo '```'
      } >>"$GITHUB_STEP_SUMMARY"
    fi
    ;;
  *)
    echo "::error::command must be sync or site, got '${INPUT_COMMAND:-}'"
    exit 1
    ;;
esac
