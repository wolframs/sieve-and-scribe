# Repository Working Notes

- After each coherent set of extension changes, bump the extension version number, run the relevant build/checks, commit the changes, and push the branch to `origin`.
- `pnpm check` runs typecheck + tests; `pnpm build` produces the extension. Run `pnpm check` before committing.
- For agent/chat, catalog-tool, or page-bridge changes, also run `pnpm test:assistant:e2e` (isolated Chromium with mocked services, no API credit). Install its browser once with `pnpm exec playwright install chromium`.
- Do not `git stash` in this repo — sessions here often run several agents against one working tree, and a stash sweeps up everyone's uncommitted work.
