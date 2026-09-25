# Exact resource selection

The previous Apply implementation discarded the proposed `modelVersionId` and drove a name
search. This was both ambiguous across versions and dependent on personal browsing filters.

CivitAI applies hidden preferences after fetching the catalog, so broadening the API search
alone does not reliably restore a hidden card. Apply now opens the native resource picker,
fetches the approved version through the same-origin `generation.getGenerationData` read query,
and passes that resource to the picker's own `onSelect`. It does not rewrite search responses,
change browsing preferences, substitute another version, or submit a generation.

The MAIN-world bridge locates the generation picker context through the marked search input's
committed React fiber ancestors. This is an internal site contract and may change. It requires
recognized context fields and exact metadata, rechecks current compatibility/exclusions/limits
after the request, and refuses unavailable or inaccessible versions. A timed-out request loses
its target marker so a late response cannot select anything. After selection the content script
verifies the exact version link and requested weight in Additional Resources. Missing verification
is an unknown outcome, because a mutation may have occurred. Failed/unknown cards display their
errors and pass the result to the assistant; successful cards save the result without a new turn.

Upstream contracts inspected on 2026-09-21:

- [ResourceSelectProvider](https://github.com/civitai/civitai/blob/main/src/components/ImageGeneration/GenerationForm/ResourceSelectProvider.tsx): context, allowed resource families, exclusions and selection callback.
- [ResourceSelectCard](https://github.com/civitai/civitai/blob/main/src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard.tsx): exact-version generation metadata and native selection.
- [generation-graph.store](https://github.com/civitai/civitai/blob/main/src/store/generation-graph.store.ts): metadata query and preview option.
- [useApplyHiddenPreferences](https://github.com/civitai/civitai/blob/main/src/components/HiddenPreferences/useApplyHiddenPreferences.ts): client-side removal of hidden models and previews.

`pnpm test:assistant:e2e` exercises the real built extension and MAIN/isolated-world bridge
against a picker fixture matching these context fields. It verifies two hidden suggestions with
distinct version IDs/weights, no extra completions after Apply, unchanged browsing preferences,
and errors for incompatible resources, a changed picker, and discarded state updates. Unit tests
also cover access denial, unavailable versions, duplicates, staged selections, limits, late
responses and transport decoding. These fixtures do not prove compatibility with a live logged-in
deployment; retest the picker manually when CivitAI changes its UI.
