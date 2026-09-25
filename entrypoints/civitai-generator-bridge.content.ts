import {
  GENERATOR_PROMPT_RESULT_EVENT,
  GENERATOR_PROMPT_SET_EVENT,
  GENERATOR_PROMPT_TARGET_ATTR,
  GENERATOR_RESOURCE_SET_EVENT,
  GENERATOR_RESOURCE_RESULT_EVENT,
  type GeneratorPromptSetRequest,
  type GeneratorPromptSetResult,
} from '@/lib/generator-page-bridge';
import { selectExactResource } from '@/lib/resource-picker';

interface TiptapElement extends HTMLElement {
  editor?: {
    commands?: {
      setContent?: (content: string) => unknown;
    };
  };
}

/**
 * CivitAI stores the generator's real prompt state in a Tiptap editor object attached to
 * the ProseMirror element. Chrome hides page-owned JavaScript properties from isolated
 * content scripts, so this MAIN-world entrypoint performs the Tiptap transaction and
 * exact resource selection through the open native picker's callback.
 */
export default defineContentScript({
  matches: ['https://civitai.com/*', 'https://civitai.red/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const pageWindow = window as typeof window & { __cllpGeneratorBridgeInstalled?: boolean };
    if (pageWindow.__cllpGeneratorBridgeInstalled) return;
    pageWindow.__cllpGeneratorBridgeInstalled = true;

    let selectingResource = false;
    window.addEventListener(GENERATOR_RESOURCE_SET_EVENT, async (event) => {
      let request;
      try { request = JSON.parse((event as CustomEvent).detail); } catch { return; }
      if (typeof request?.id !== 'string') return;
      const result = selectingResource
        ? { id: request.id, ok: false, error: 'Another resource is still being selected.' }
        : await (async () => {
          selectingResource = true;
          try { return await selectExactResource(request); }
          finally { selectingResource = false; }
        })();
      window.dispatchEvent(new CustomEvent(GENERATOR_RESOURCE_RESULT_EVENT, { detail: JSON.stringify(result) }));
    });

    window.addEventListener(GENERATOR_PROMPT_SET_EVENT, (event) => {
      let request: GeneratorPromptSetRequest | undefined;
      let ok = false;
      try {
        const detail = (event as CustomEvent).detail;
        request = typeof detail === 'string' ? JSON.parse(detail) : detail;
        if (
          !request ||
          typeof request.id !== 'string' ||
          typeof request.value !== 'string'
        ) {
          return;
        }

        const target = [
          ...document.querySelectorAll<TiptapElement>(`[${GENERATOR_PROMPT_TARGET_ATTR}]`),
        ].find((element) => element.getAttribute(GENERATOR_PROMPT_TARGET_ATTR) === request!.id);
        const setContent = target?.editor?.commands?.setContent;
        if (target && typeof setContent === 'function') {
          setContent.call(target.editor!.commands, request.value);
          ok = true;
        }
      } catch {
        ok = false;
      } finally {
        if (request?.id) {
          const result: GeneratorPromptSetResult = { id: request.id, ok };
          window.dispatchEvent(
            new CustomEvent(GENERATOR_PROMPT_RESULT_EVENT, {
              detail: JSON.stringify(result),
            })
          );
        }
      }
    });
  },
});
