# Browser smoke rig

For cheap, self-contained agent-chain regression tests, use `pnpm test:assistant:e2e` after the
one-time `pnpm exec playwright install chromium`. This builds the extension and tests its actual
side-panel document and page bridge against mocked services in a disposable profile. Screenshots
are saved under `.artifacts/agent-e2e/`. It requires no API keys or existing browser session.
The live-site smoke below remains separate because mocks cannot detect CivitAI DOM/API changes.

`pnpm test:e2e` is a smoke check against this repository's dedicated Chrome profile and
`chrome-devtools` daemon session. Runtime state lives under ignored `.browser-smoke/`; the daemon
uses session ID `sieve-and-scribe-smoke`. It does not start, stop, reconnect, or send commands
to the CLI's default daemon, so browser sessions owned by other coding agents remain independent.

## What the script assumes

Before running it, you need:

1. The extension built at `.output/chrome-mv3` with `pnpm build`.
2. The `chrome-devtools` CLI on `PATH` with session-scoped daemon support.
3. The project daemon/profile prepared with `pnpm browser:smoke:setup`.
4. Network access to `https://civitai.red/images` and the configured providers' model catalogs.

Setup writes the installed ID to ignored `.browser-smoke/extension-id`. To override it without
editing the script:

```sh
CLLP_E2E_EXTENSION_ID=your_profile_extension_id pnpm test:e2e
```

Every lifecycle and smoke command passes the same project session ID explicitly.

No CivitAI login or LLM API key is required for the intended assertions. The popup deliberately
accepts either `Configured` or `Missing` as a resolved key state. Provider model-catalog checks do
require their public endpoints to be reachable and may fail independently of the extension UI.

## Starting or reconnecting the rig

Build, launch the isolated project daemon/profile, and install the unpacked extension:

```sh
pnpm build
pnpm browser:smoke:setup
```

The helper prefers Chrome for Testing from the local Puppeteer cache, then checks normal Chrome or
Chromium locations. Override detection when needed:

```sh
CLLP_E2E_CHROME_PATH=/absolute/path/to/chrome pnpm browser:smoke:setup
```

Lifecycle commands affect only this project session:

```sh
pnpm browser:smoke:status
pnpm browser:smoke:install  # reinstall/update after pnpm build
pnpm browser:smoke:stop
```

The daemon's extension commands must be enabled. Current CLI releases expose this as the
`--categoryExtensions` start option; check `chrome-devtools start --help` for the installed
version if `list_extensions` is unavailable. The helper also enables unrestricted path access for
this dedicated local daemon because the standalone CLI cannot negotiate MCP workspace roots and
`install_extension` must read `.output/chrome-mv3`.

## Diagnosing the `/opt/google/chrome/chrome` failure

The old shared rig expected Chrome at `/opt/google/chrome/chrome`. That path is not a project
prerequisite. The project helper resolves a real executable or accepts `CLLP_E2E_CHROME_PATH`.

```sh
test -x /opt/google/chrome/chrome && echo usable
command -v google-chrome-stable google-chrome chromium chromium-browser
pnpm browser:smoke:status
```

If the first command fails, pass a real executable returned by `command -v` (or a
Chrome-for-Testing binary) through `CLLP_E2E_CHROME_PATH`. Never repair this rig with unscoped
`chrome-devtools start` or `stop`; those commands target the shared default daemon.

## Running the smoke

```sh
pnpm build
pnpm test:e2e
```

The script opens temporary pages and closes the page indices it recorded. It exits nonzero when
any assertion fails. A `suite aborted` result generally means the rig/CLI/navigation failed before
all feature assertions could run; diagnose that separately from an individual failed check.

## Coverage

The smoke currently checks:

- the expected extension ID is installed;
- the feed tag-filter host and launcher mount on `civitai.red/images`;
- the native Filters popup gains a left column without changing its height or native content width;
- closing and reopening the native popup preserves unsubmitted editor text;
- the compact metadata editor renders, summarizes a portrait/reaction filter, and applies its URL;
- the editor can resolve and select a model version through CivitAI's public search;
- a current public detail page still exposes tags and detail-tag pickup can add then remove one;
- staged tray tags expose three 32px actions and direct AND assignment works;
- the isolated-world site-health toast listener receives a main-page event;
- the side-panel chat shell and model picker render;
- popup provider, key-status, and model controls resolve;
- options-page provider model selectors and the default system prompt load.

It does **not** check:

- CivitAI authentication or the live generation form;
- prompt/source/resource application or Generate confirmation;
- real LLM requests, tool loops, Site MCP behavior, or spending;
- conversation/settings persistence across extension reloads;
- Firefox or other browsers;
- pixel-perfect visual layout, full accessibility auditing, or broad CivitAI-site compatibility.

Those behaviors need their targeted unit, contract, and opt-in live assistant evaluations. A green
browser smoke means that several primary extension surfaces mounted in one prepared Chrome rig; it
is not an end-to-end claim for the assistant.
