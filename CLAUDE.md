# Repository Working Notes

- After each coherent set of extension changes, bump the extension version number, run the relevant build/checks, commit the changes, and push the branch to `origin`.
- `pnpm check` runs typecheck + tests; `pnpm build` produces the extension. Run `pnpm check` before committing.
- For agent/chat, catalog-tool, or page-bridge changes, also run `pnpm test:assistant:e2e` (isolated Chromium with mocked services, no API credit). Install its browser once with `pnpm exec playwright install chromium`.
- Publishing: `origin` (Forgejo) holds the full history; GitHub (`wolframs/sieve-and-scribe`, public) holds snapshots only. This history must never be pushed to GitHub, so this checkout has no GitHub remote on purpose; do not add one. To publish, commit on `main`, then run `tools/publish-github.sh` (dry run: shows the diff against GitHub `main`) and `tools/publish-github.sh --push` (one new commit on top of GitHub `main`, named after the version). The script refuses to publish page captures, keys, `.env` files and private network addresses.
- Do not `git stash` in this repo — sessions here often run several agents against one working tree, and a stash sweeps up everyone's uncommitted work.
