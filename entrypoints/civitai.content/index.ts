import { type ProposedAction } from '@/lib/page-tools';
import { applyPromptAction } from '@/lib/action-apply';
import {
  getFeedKind,
  parseNegativeTagsFromSearch,
  parseTagGroupsFromSearch,
  parseTagsFromSearch,
  parseModeFromSearch,
  buildHrefWithTagFilter,
  resolveTagNames,
  writeFeedFilterStash,
} from '@/lib/civitai-feed-tags';
import { parseFeedFacetsFromSearch } from '@/lib/feed-facets';

import { createChatController } from '@/lib/chat-controller';
import { registerPageBridge } from '@/lib/page-bridge';
import { executeCivitaiTool } from '@/lib/civitai-tools';
import type { FormState } from '@/lib/types';
import {
  detectForm,
  readFormState,
  setPrompt,
  setParameter,
  highlightField,
  isGeneratorAvailable,
  isOnGeneratePath,
  attachResource,
  watchForForm,
  getOpenImageUrl,
  getVisibleImageUrls,
  getGeneratorImages,
  applyGeneratorImage,
  submitGenerate,
  formContractIssues,
} from './dom-bridge';

import { initFeedTagFilter } from './feed-tag-filter';
import { initSiteHealth, reportSiteIssue } from './site-health';
import { installDiagnosticCapture } from '@/lib/diagnostic-log';

export default defineContentScript({
  matches: ['https://civitai.com/*', 'https://civitai.red/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    installDiagnosticCapture('content');
    // Site-contract watchdog: console + toast feedback when CivitAI changes under us.
    initSiteHealth();

    // Inject the feed tag-filter widget on /images and /videos (independent of the chat panel).
    initFeedTagFilter(ctx);

    // The chat flow, with direct DOM page access (this IS the page).
    const controller = createChatController({
      onGeneratePage: async () => isGeneratorAvailable(),
      formState: async () => (isGeneratorAvailable() ? readFormState() : null),
      pageContext: getPageContext,
      pageImages: async (limit) => getPageImages(limit),
      generatorImages: async () => getGeneratorImages(),
      applyAction: handleApplyAction,
    });

    // Serve the same page operations to the side panel (which has no DOM access).
    registerPageBridge({
      route: () => ({
        url: location.href,
        path: location.pathname,
        onGeneratePage: isGeneratorAvailable(),
      }),
      formState: () => (isGeneratorAvailable() ? readFormState() : null),
      applyAction: handleApplyAction,
      pageContext: getPageContext,
      pageImages: getPageImages,
      generatorImages: getGeneratorImages,
      openImageUrl: getOpenImageUrl,
      catalogTool: (name, args, token) => executeCivitaiTool(name, args, token, AbortSignal.timeout(25_000), location.origin),
    });

    // Watch for form changes
    let currentFormState: FormState | null = null;
    watchForForm((detected) => {
      // The Create drawer opens and closes without touching the URL, so this observer is the
      // only signal that Apply just became (un)available — locationchange never fires. The
      // side panel has no DOM access and otherwise only re-syncs on tab/URL events, so push
      // the change to it. Rejects when no extension page is open — that's fine.
      browser.runtime
        .sendMessage({ type: 'cllp:form-availability' })
        .catch(() => {});
      if (detected) {
        currentFormState = readFormState();
        // Form recognized — verify the finer structural contract once things settle.
        setTimeout(() => {
          if (!isGeneratorAvailable() || !detectForm()) return;
          for (const missing of formContractIssues()) {
            reportSiteIssue(
              `gen-contract:${missing}`,
              `CivitAI's generate form changed: can't find ${missing}. Apply-to-form may misbehave.`
            );
          }
        }, 2000);
      } else {
        currentFormState = null;
      }
    });

    // If we sit on /generate and never even recognize the form, that's the loudest contract
    // break of all (it's how the 2026 redesign went unnoticed) — say so after a grace period.
    let formGraceTimer: number | undefined;
    const scheduleFormPresenceCheck = () => {
      clearTimeout(formGraceTimer);
      if (!isOnGeneratePath()) return;
      formGraceTimer = window.setTimeout(() => {
        if (isOnGeneratePath() && !detectForm()) {
          reportSiteIssue(
            'gen-form-missing',
            "CivitAI's generate form was not recognized — the site layout may have changed. Prompt Apply is unavailable."
          );
        }
      }, 10000);
    };
    scheduleFormPresenceCheck();

    // Handle SPA navigation: re-check whether the generate form is reachable.
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      void browser.runtime.sendMessage({ type: 'cllp:form-availability' }).catch(() => {});
      scheduleFormPresenceCheck();
    });

    /** Snapshot of the current page for the LLM's get_page_context tool. */
    async function getPageContext(): Promise<Record<string, unknown>> {
      const path = location.pathname;
      const onGenerate = isGeneratorAvailable();
      const feedKind = getFeedKind(path);
      const ctx: Record<string, unknown> = { url: location.href, path, onGeneratePage: onGenerate };
      if (onGenerate) ctx.form = readFormState();
      if (feedKind) {
        const ids = parseTagsFromSearch(location.search);
        const excludedIds = parseNegativeTagsFromSearch(location.search);
        const groups = parseTagGroupsFromSearch(location.search);
        const names = await resolveTagNames([...ids, ...excludedIds]).catch(() => new Map<number, string>());
        ctx.feed = {
          kind: feedKind,
          mode: parseModeFromSearch(location.search),
          appliedTags: ids.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
          positiveGroups: groups.map((group) => group.map((id) => ({ id, name: names.get(id) ?? `#${id}` }))),
          excludedTags: excludedIds.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
          facets: parseFeedFacetsFromSearch(location.search),
        };
      }
      const openImage = getOpenImageUrl();
      if (openImage) ctx.openImageUrl = openImage;
      const visible = getVisibleImageUrls(6);
      if (visible.length) ctx.visibleImageCount = visible.length;
      return ctx;
    }

    /** Visible page images (open image first) for the LLM's view_page_images tool. */
    function getPageImages(limit: number): string[] {
      const open = getOpenImageUrl();
      const vis = getVisibleImageUrls(limit);
      if (open) return [open, ...vis.filter((u) => u !== open)].slice(0, limit);
      return vis.slice(0, limit);
    }

    /** Apply an LLM-proposed page action after the user confirms it (the card's Apply button). */
    async function handleApplyAction(
      action: ProposedAction
    ): Promise<{ success: boolean; error: string | null }> {
      try {
        if (action.kind === 'prompt') {
          return applyPromptAction(action, {
            isGeneratorAvailable,
            setPrompt,
            setParameter,
            readFormState,
            highlightField,
          });
        }
        if (action.kind === 'feedFilter') {
          const base = getFeedKind(location.pathname) ? location.href : 'https://civitai.com/images';
          writeFeedFilterStash(localStorage, {
            groups: action.tags.map((tag) => [tag.id]),
            negatives: [],
            mode: action.mode,
            bundles: [],
            facets: action.facets ?? null,
          });
          location.assign(
            buildHrefWithTagFilter(
              base,
              action.tags.map((tag) => [tag.id]),
              [],
              action.mode,
              action.facets
            )
          );
          return { success: true, error: null };
        }
        if (action.kind === 'navigate') {
          // Re-validate before navigating, in case the action object was tampered/replayed.
          const url = action.url;
          const ok = url.startsWith('/') || /^https?:\/\/(www\.)?civitai\.(com|red)(\/|$)/.test(url);
          if (!ok) return { success: false, error: 'Refusing to navigate off Civitai.' };
          location.assign(url.startsWith('/') ? `https://civitai.com${url}` : url);
          return { success: true, error: null };
        }
        if (action.kind === 'resource') {
          if (!isGeneratorAvailable()) return { success: false, error: "Open CivitAI's generator first — the /generate page or the Create drawer." };
          const res = await attachResource(action.versionId, action.name, action.weight);
          return res.ok
            ? { success: true, error: null }
            : { success: false, error: res.error ?? 'Could not attach the resource.', ...(res.unknown ? { unknown: true } : {}) };
        }
        if (action.kind === 'sourceImage') {
          if (!isGeneratorAvailable()) {
            return {
              success: false,
              error: "Open CivitAI's generator first — the /generate page or the Create drawer.",
            };
          }
          const result = await applyGeneratorImage(action.url, action.slot, action.name);
          return result.ok
            ? { success: true, error: null }
            : { success: false, error: result.error ?? 'Could not load the source image.' };
        }
        if (action.kind === 'generate') {
          if (!isGeneratorAvailable()) return { success: false, error: "Open CivitAI's generator first — the /generate page or the Create drawer." };
          return submitGenerate()
            ? { success: true, error: null }
            : { success: false, error: 'Could not find the Generate button.' };
        }
        return { success: false, error: 'Unknown action.' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to apply action.' };
      }
    }

  },
});
