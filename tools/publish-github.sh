#!/usr/bin/env bash
# Publish the committed tree of `main` to GitHub as one new commit on top of
# GitHub's `main`. This repository's own history is never pushed there.
#
#   tools/publish-github.sh          show what would change, push nothing
#   tools/publish-github.sh --push   commit the snapshot and push it
#
# The snapshot is `git archive HEAD`, so only committed, tracked files go out.
set -euo pipefail

REMOTE_URL="https://github.com/wolframs/sieve-and-scribe.git"

die() { echo "publish-github: $*" >&2; exit 1; }

push=0
case "${1:-}" in
  --push) push=1 ;;
  "") ;;
  *) die "unknown argument: $1 (use --push or nothing)" ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(git branch --show-current)" == "main" ]] || die "check out main first"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean; commit first"

src="$(git rev-parse --short HEAD)"
subject="$(git log -1 --format=%s HEAD)"
version="$(node -p 'require("./package.json").version')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone -q --depth 1 --branch main "$REMOTE_URL" "$work/pub"
git -C "$work/pub" rm -rq --ignore-unmatch -- .
git archive HEAD | tar -x -C "$work/pub"
git -C "$work/pub" add -A

# Things that must never reach the public tree. A hit stops the run; fix the
# file on main, commit, and run again.
bad_files="$(git -C "$work/pub" diff --cached --name-only --diff-filter=AM \
  | grep -i -E '\.(mhtml|har|pem|key)$|(^|/)\.env($|\.)' || true)"
[[ -z "$bad_files" ]] || die "refusing, files that do not go public:"$'\n'"$bad_files"
bad_lines="$(git -C "$work/pub" grep --cached -n -I -E \
  '(^|[^0-9.])(192\.168\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)' \
  || true)"
[[ -z "$bad_lines" ]] || die "refusing, private network addresses:"$'\n'"$bad_lines"

if git -C "$work/pub" diff --cached --quiet; then
  echo "GitHub main already matches main ($src). Nothing to publish."
  exit 0
fi

echo "Changes against GitHub main, from main $src (v$version):"
git -C "$work/pub" diff --cached --stat | tail -n 25

if [[ $push -eq 0 ]]; then
  echo
  echo "Dry run. Run again with --push to publish."
  exit 0
fi

git -C "$work/pub" \
  -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
  commit -q -m "v$version: $subject" -m "Snapshot of the private main at $src."
git -C "$work/pub" push -q origin main
echo "Published v$version to $REMOTE_URL"
