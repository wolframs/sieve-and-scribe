# Native feed filter integration (v1.0.66)

The v1.0.65 checkpoint already contains tag-group dragging and summaries, the focused group editor,
draft history, similarity bundles, reusable groups, expression import/export, and numeric-name
resolution. The original feed-filter plan proposed mounting near the filter row; the actual widget
still used a fixed upper-left panel. v1.0.66 implements the requested native popup integration.

## DOM contract

Inspected on `https://civitai.com/images` on 2026-09-05 in the dedicated project Chrome rig.
The in-app browser backend was unavailable in this session.

- The Filters button contains `.tabler-icon-filter` and sits inside an indicator wrapper carrying
  `aria-controls` and `aria-expanded`.
- That relationship identifies `.mantine-Popover-dropdown[role="dialog"]`. The additional
  `Clear all filters` button check distinguishes this popup from unrelated site dialogs.
- The native popup has two direct children: a scroll-constrained content wrapper and a footer.
  Its desktop maximum width is `29.25rem` (468 CSS pixels at the inspected scale).
- `NativeFilterDock` inserts only the extension-owned shadow host; it never moves or replaces the
  React-owned children. Scoped CSS adds left padding and width. Mantine continues positioning the
  widened popup against the original right-hand trigger.
- The extension column is up to 400px wide and can shrink to 320px. If there is insufficient room,
  editor stacks above the native controls inside the same popup. Detail routes use the same native
  integration. When native Filters are absent or the open popup is unsupported, the editor stays hidden.

The editor inherits Mantine theme variables across its shadow boundary. Its outer panel takes the
native popup's height; the active editor view can scroll when it exceeds that space, while the
history and Apply/Clear controls stay available. Suggestions overlay the editor without increasing
the popup height. The stacked panel retains natural height.

Closing a popup detaches and parks the existing host, preserving the draft, inputs, and listeners.
Opening it again reattaches that host. Escape dismisses suggestions or the current subeditor first,
then closes the native popup. Opening Filters does not automatically focus search or load suggestions.
Native and extension filters still have independent Apply buttons; this change does not combine
their pending drafts into a shared transaction.

## Editor styling (v1.0.67)

The editor's stylesheet lives in `entrypoints/civitai.content/feed-tag-filter.styles.ts` and is
injected into the widget's shadow root. Every colour resolves from Mantine's theme variables
(`--mantine-color-default`, `-default-hover`, `-body`, `-text`, `-dimmed`, `-default-border`,
`--mantine-primary-color-filled`/`-light-color`) so the column follows CivitAI's colour scheme;
the hex values in the file are fallbacks only. Section labels mirror the native popover's labelled
dividers. Single-tag groups render as bare chips; only multi-tag OR groups get a card. The all/any
switch is hidden until a second group exists because it changes nothing before then.

## Surviving CivitAI's own navigation (v1.0.69)

CivitAI's router rebuilds feed URLs from the params it knows, so a site-driven navigation can
keep `tags=` and drop `tagmode`/`tagneg`/`taggroups`/`tagbundles`/`ff*`. The last applied filter
is stashed in `localStorage["cllp:feed-filter-stash"]` (written by the widget on Apply and on every
intact feed load; readable from both worlds). `lib/feed-filter-url.ts` restores the markers with
`history.replaceState` when a feed URL carries exactly the stashed tag set and no markers — the
widget does it on route sync, and the MAIN-world interceptor repeats it before the first
`image.getInfinite` fetch as a cold-load backstop. A different tag set is treated as a new filter.
The "navigation dropped the tag-filter markers" warning now fires only when the same tags the widget
was just showing lose their markers and no stash covers them.

## Universal native entry point (v1.0.70)

The standalone Tags launcher is removed. Feed and detail modes both use native Filters;
generation views without those controls keep the editor hidden, including when an old saved
preference requested an expanded panel. Native popup removal parks the same host and draft.
On narrow screens the editor stacks inside the popup instead of becoming a floating panel.

## Verification and maintenance

`tests/unit/native-filter-dock.test.ts` covers original control identity/handlers, popup remounts,
responsive restoration, unrelated popovers, route mode, cleanup, persisted expansion, and Escape.
`tests/e2e/smoke.mjs` measures the live widened popup against its native geometry and checks draft
survival across closing and reopening before exercising the existing filter/editor smoke checks.

When CivitAI changes the filter UI, recheck the trigger relationship and popup structure before
loosening detection. Keep geometry assertions in the live smoke and preserve native DOM ownership.
