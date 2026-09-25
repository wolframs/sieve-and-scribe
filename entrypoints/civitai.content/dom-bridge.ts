import { SELECTORS, GENERATE_PATH } from '@/lib/constants';
import {
  GENERATOR_PROMPT_RESULT_EVENT,
  GENERATOR_PROMPT_SET_EVENT,
  GENERATOR_PROMPT_TARGET_ATTR,
  GENERATOR_RESOURCE_SET_EVENT,
  GENERATOR_RESOURCE_RESULT_EVENT,
  GENERATOR_RESOURCE_TARGET_ATTR,
  type GeneratorResourceResult,
  type GeneratorPromptSetRequest,
  type GeneratorPromptSetResult,
} from '@/lib/generator-page-bridge';
import type {
  FormState,
  GeneratorImage,
  GeneratorImageSlot,
  VideoWorkflow,
} from '@/lib/types';

/**
 * Field targeting for CivitAI's generator (2026 redesign).
 *
 * The generator's DOM has NO stable ids — Mantine generates random ones per mount — so
 * fields are located structurally: prompt editors are tiptap/ProseMirror contenteditables
 * told apart by wrapper label/placeholder text; numeric params live in Mantine
 * InputWrappers found by label; aspect ratio and discrete video options are
 * SegmentedControls. Which params exist depends on the selected model family (Flux hides
 * CFG/sampler/CLIP skip; video ecosystems expose different duration/CFG/resolution shapes)
 * — setters silently no-op on absent fields.
 */

/**
 * Set the value of a React-controlled input/textarea.
 * Uses the nativeInputValueSetter technique to properly trigger React state updates.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

interface TiptapElement extends HTMLElement {
  editor?: {
    commands?: {
      setContent?: (content: string) => unknown;
    };
  };
}

let promptRequestSequence = 0;

/** Ask the MAIN-world bridge to transact against CivitAI's page-owned Tiptap editor. */
function setPageWorldPrompt(element: HTMLElement, value: string): boolean {
  const id = `${Date.now()}:${++promptRequestSequence}`;
  const request: GeneratorPromptSetRequest = { id, value };
  let result = false;

  const onResult = (event: Event) => {
    try {
      const detail = (event as CustomEvent).detail;
      const parsed: GeneratorPromptSetResult =
        typeof detail === 'string' ? JSON.parse(detail) : detail;
      if (parsed?.id === id) result = parsed.ok === true;
    } catch {
      /* malformed/unrelated result — use the compatibility fallback below */
    }
  };

  element.setAttribute(GENERATOR_PROMPT_TARGET_ATTR, id);
  window.addEventListener(GENERATOR_PROMPT_RESULT_EVENT, onResult);
  try {
    window.dispatchEvent(
      new CustomEvent(GENERATOR_PROMPT_SET_EVENT, {
        detail: JSON.stringify(request),
      })
    );
  } finally {
    window.removeEventListener(GENERATOR_PROMPT_RESULT_EVENT, onResult);
    element.removeAttribute(GENERATOR_PROMPT_TARGET_ATTR);
  }
  return result;
}

/**
 * Set text content of a tiptap/ProseMirror contenteditable.
 *
 * CivitAI's graph-driven generator no longer observes direct DOM edits: execCommand can
 * visibly change the editor while leaving the form graph (and submitted prompt) untouched.
 * Tiptap exposes its Editor instance on the ProseMirror element; its setContent command
 * creates a real transaction and drives the graph's onUpdate callback. Keep the DOM-event
 * fallback for older generator builds.
 */
function setContentEditableValue(element: HTMLElement, value: string): void {
  if (setPageWorldPrompt(element, value)) return;

  const tiptap = element as TiptapElement;
  if (typeof tiptap.editor?.commands?.setContent === 'function') {
    tiptap.editor.commands.setContent(value);
    return;
  }

  element.focus();
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

// --- structural finders ---

function allPromptEditors(): HTMLElement[] {
  return [
    ...new Set(
      document.querySelectorAll<HTMLElement>(
        '.ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]'
      )
    ),
  ];
}

/** Label + placeholder context of a prompt editor, lowercased, for telling fields apart. */
function editorContext(editor: HTMLElement): string {
  const ph =
    editor.getAttribute('data-placeholder') ??
    editor.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') ??
    '';
  const labels: string[] = [];
  let el: HTMLElement | null = editor;
  for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
    for (const label of el.querySelectorAll<HTMLElement>(':scope > label')) {
      labels.push(label.textContent ?? '');
    }
    if (el.matches('[class*="InputWrapper-root"]')) {
      labels.push(el.querySelector('label')?.textContent ?? '');
    }
  }
  return `${labels.join(' ')} ${ph} ${editor.getAttribute('aria-label') ?? ''}`.toLowerCase();
}

function findPromptEditor(field: 'prompt' | 'negativePrompt'): HTMLElement | null {
  const editors = allPromptEditors();
  if (!editors.length) return null;
  const isNeg = (e: HTMLElement) => /negative|avoid/.test(editorContext(e));
  if (field === 'negativePrompt') {
    return editors.find(isNeg) ?? (editors.length > 1 ? editors[1] : null);
  }
  return editors.find((e) => !isNeg(e)) ?? editors[0];
}

const VIDEO_WORKFLOW_COPY: Record<VideoWorkflow, { title: string; description: RegExp }> = {
  textToVideo: { title: 'Text to Video', description: /generate video from text/i },
  imageToVideo: { title: 'Image to Video', description: /generate video from an image/i },
  referenceToVideo: {
    title: 'Reference to Video',
    description: /generate video using (?:a )?reference image/i,
  },
};

/** Active workflow heading; unlike the neighboring buttons it has a descriptive <p> below it. */
function detectVideoWorkflow(): VideoWorkflow | undefined {
  for (const [workflow, copy] of Object.entries(VIDEO_WORKFLOW_COPY) as Array<
    [VideoWorkflow, (typeof VIDEO_WORKFLOW_COPY)[VideoWorkflow]]
  >) {
    const heading = [...document.querySelectorAll<HTMLElement>('p')].find(
      (element) => element.textContent?.trim() === copy.title
    );
    const container = heading?.parentElement;
    if (
      container &&
      [...container.querySelectorAll<HTMLElement>('p')].some((element) =>
        copy.description.test(element.textContent?.trim() ?? '')
      )
    ) {
      return workflow;
    }
  }
  return undefined;
}

function generatorImageInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter((input) =>
    /image\/(?:png|jpeg|webp)|image\/\*/i.test(input.accept)
  );
}

function generatorImageInputContext(input: HTMLInputElement): string {
  const text: string[] = [];
  let element: HTMLElement | null = input;
  // Stop before the two-column first/last-frame wrapper: once both dropzones enter
  // the context, each input appears to be both the first and last frame.
  for (let i = 0; i < 3 && element; i++, element = element.parentElement) {
    text.push(element.innerText ?? '');
  }
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

function generatorImageCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[class*="Card-root"]')].filter(
    (card) =>
      !!card.querySelector<HTMLImageElement>('img[alt="image"]') &&
      !!card.querySelector('button svg[class*="icon-x"]')
  );
}

function availableGeneratorImageSlots(): GeneratorImageSlot[] {
  const workflow = detectVideoWorkflow();
  if (!workflow || workflow === 'textToVideo') return [];
  if (workflow === 'referenceToVideo') return ['reference'];

  const contexts = generatorImageInputs().map(generatorImageInputContext);
  const firstLast =
    generatorImageCards().length > 1 ||
    contexts.some((context) => /\b(?:first|last)\s+frame\b/i.test(context));
  return firstLast ? ['firstFrame', 'lastFrame'] : ['source'];
}

/** Source/reference images already uploaded into CivitAI, labeled in visible slot order. */
export function getGeneratorImages(): GeneratorImage[] {
  const workflow = detectVideoWorkflow();
  const cards = generatorImageCards();
  const slots = availableGeneratorImageSlots();
  return cards.flatMap((card, index): GeneratorImage[] => {
    const image = card.querySelector<HTMLImageElement>('img[alt="image"]');
    const url = image?.currentSrc || image?.src;
    if (!url) return [];
    const dimensions = /(\d+)\s*x\s*(\d+)/i.exec(card.innerText);
    const slot: GeneratorImageSlot =
      workflow === 'referenceToVideo'
        ? 'reference'
        : slots.includes('firstFrame')
          ? index === 0
            ? 'firstFrame'
            : 'lastFrame'
          : 'source';
    return [
      {
        slot,
        url,
        ...(dimensions
          ? { width: Number(dimensions[1]), height: Number(dimensions[2]) }
          : {}),
      },
    ];
  });
}

/** First Mantine InputWrapper whose label matches. */
function findLabeledWrapper(re: RegExp): HTMLElement | null {
  for (const wrap of document.querySelectorAll<HTMLElement>('[class*="InputWrapper-root"]')) {
    const label = wrap.querySelector('label');
    if (label && re.test(label.textContent?.trim() ?? '')) return wrap;
  }
  return null;
}

function findLabeledInput(re: RegExp): HTMLInputElement | null {
  // NumberSlider renders a hidden backing input before its visible NumberInput. The old
  // broad selector picked that hidden input, so React never saw the write. Prefer the
  // visible input's aria-label, then fall back to a labeled wrapper.
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])'
  )) {
    const labels = [
      input.getAttribute('aria-label'),
      input.getAttribute('name'),
      input.getAttribute('placeholder'),
      ...[...(input.labels ?? [])].map((label) => label.textContent),
    ]
      .filter(Boolean)
      .join(' ');
    if (re.test(labels.trim())) return input;
  }
  return (
    findLabeledWrapper(re)?.querySelector<HTMLInputElement>(
      'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])'
    ) ?? null
  );
}

const FIELD_LABELS: Record<string, RegExp> = {
  cfgScale: /^(cfg|guidance)/i,
  steps: /^steps/i,
  sampler: /^sampler/i,
  clipSkip: /^clip\s*skip/i,
};

function findLabeledSlider(re: RegExp): HTMLElement | null {
  for (const slider of document.querySelectorAll<HTMLElement>('[role="slider"]')) {
    const context = `${slider.getAttribute('aria-label') ?? ''} ${
      slider.closest<HTMLElement>('[class*="InputWrapper-root"]')?.querySelector('label')
        ?.textContent ?? ''
    }`;
    if (re.test(context.trim())) return slider;
  }
  return null;
}

function numericRange(re: RegExp): { min: number; max: number; step?: number } | undefined {
  const slider = findLabeledSlider(re);
  if (!slider) return undefined;
  const min = Number(slider.getAttribute('aria-valuemin'));
  const max = Number(slider.getAttribute('aria-valuemax'));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  const input = findLabeledInput(re);
  const stepAttr = input?.getAttribute('step');
  const step = stepAttr == null ? undefined : Number(stepAttr);
  return {
    min,
    max,
    ...(Number.isFinite(step) ? { step } : {}),
  };
}

function readLabeledNumber(re: RegExp, parse: (s: string) => number): number | undefined {
  const input = findLabeledInput(re);
  const raw = input?.value ?? findLabeledSlider(re)?.getAttribute('aria-valuenow');
  if (raw == null) return undefined;
  const value = parse(raw);
  return Number.isFinite(value) ? value : undefined;
}

function setLabeledNumber(re: RegExp, value: string | number): boolean {
  const input = findLabeledInput(re);
  if (!input) return false;
  let numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  const range = numericRange(re);
  if (range) numeric = Math.min(range.max, Math.max(range.min, numeric));
  setNativeValue(input, String(numeric));
  return true;
}

/** Text attached to a radio group by either Mantine InputWrapper or a simple parent label. */
function radioGroupContext(radio: HTMLInputElement): string {
  let el: HTMLElement | null = radio;
  const labels: string[] = [];
  for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
    if (el.matches('[class*="InputWrapper-root"]')) {
      labels.push(el.querySelector('label')?.textContent ?? '');
    }
    for (const label of el.querySelectorAll<HTMLElement>(':scope > label')) {
      labels.push(label.textContent ?? '');
    }
  }
  return labels.join(' ').trim();
}

/** The aspect-ratio SegmentedControl radios (values are ratio strings like "2:3"). */
function aspectRadios(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) =>
    /^\d+:\d+$/.test(r.value) && /aspect\s*ratio/i.test(radioGroupContext(r))
  );
}

/**
 * The video form's Duration SegmentedControl (radio values are second counts: "5", "10").
 * Identified by the group label rather than the values, so it can't collide with other
 * numeric radio groups.
 */
function durationRadios(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => {
    if (!/^\d+$/.test(r.value)) return false;
    return /\bduration\b/i.test(radioGroupContext(r));
  });
}

function resolutionRadios(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (r) => /^\d+p$/i.test(r.value) && /\bresolution\b/i.test(radioGroupContext(r))
  );
}

/** Select a clip duration in seconds; falls back to the nearest offered length. */
function setDuration(value: string | number): boolean {
  const radios = durationRadios();
  const want = Number(String(value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(want)) return false;
  if (!radios.length) return setLabeledNumber(/^duration/i, want);
  const target =
    radios.find((r) => Number(r.value) === want) ??
    radios
      .slice()
      .sort((a, b) => Math.abs(Number(a.value) - want) - Math.abs(Number(b.value) - want))[0];
  if (!target) return false;
  target.click();
  return true;
}

function setResolution(value: string): boolean {
  const radios = resolutionRadios();
  const target = radios.find((radio) => radio.value.toLowerCase() === value.trim().toLowerCase());
  if (!target) return false;
  target.click();
  return true;
}

function findGenerateAudioInput(): HTMLInputElement | null {
  return (
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[role="switch"]')].find(
      (input) =>
        [...(input.labels ?? [])].some((label) =>
          /^generate\s+audio$/i.test(label.textContent?.trim() ?? '')
        ) || /^generate\s+audio$/i.test(input.getAttribute('aria-label') ?? '')
    ) ?? null
  );
}

function setGenerateAudio(value: boolean): boolean {
  const input = findGenerateAudioInput();
  if (!input) return false;
  if (input.checked !== value) input.click();
  return true;
}

/** Numeric ratio of "2:3" / "832x1216" style strings, or null. */
function ratioOf(v: string): number | null {
  const m = /^(\d+)\s*[:x×]\s*(\d+)$/i.exec(v.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return h > 0 ? w / h : null;
}

/**
 * Select the aspect-ratio option: exact value match first ("2:3"), otherwise the option
 * numerically closest to the requested ratio — so "832x1216" still lands on "2:3".
 */
function setAspectRatio(value: string): boolean {
  const radios = aspectRadios();
  if (!radios.length) return false;
  let target = radios.find((r) => r.value === value.trim());
  if (!target) {
    const want = ratioOf(value);
    if (want == null) return false;
    let bestDist = Infinity;
    for (const r of radios) {
      const ratio = ratioOf(r.value);
      if (ratio == null) continue;
      const d = Math.abs(ratio - want);
      if (d < bestDist) {
        bestDist = d;
        target = r;
      }
    }
  }
  if (!target) return false;
  target.click(); // Mantine radio: click drives the React onChange
  return true;
}

/** Poll until `fn` yields something truthy, or give up. The resource picker loads async. */
async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 6000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** The "Additional Resources" section (absent for models that take no LoRAs). */
function resourceSection(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[class*="InputWrapper-root"]')].find((w) =>
      /additional resources/i.test(w.innerText || '')
    ) ?? null
  );
}

function openResourceDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"], [class*="Modal-content"]');
}

/** Attach the approved version through the native picker, independently of browse filters. */
export async function attachResource(
  versionId: number,
  name: string,
  weight?: number
): Promise<{ ok: boolean; error?: string; unknown?: boolean }> {
  const section = resourceSection();
  if (!section) return { ok: false, error: 'This model has no "Additional Resources" section — it does not take LoRAs.' };
  const resourceLink = () => [...(resourceSection()?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])]
    .find((link) => {
      try { return Number(new URL(link.href, location.href).searchParams.get('modelVersionId')) === versionId; }
      catch { return false; }
    });
  if (resourceLink()) return { ok: false, error: `Version ${versionId} is already attached. Adjust its weight in the generator instead of adding it again.` };
  const addBtn = [...section.querySelectorAll('button')].find((b) => /^add$/i.test((b.textContent || '').trim()));
  if (!addBtn || addBtn.disabled) return { ok: false, error: 'Could not find an enabled Add button for resources; the generator may be at its resource limit.' };
  addBtn.click();
  const dialog = await waitFor(openResourceDialog, 5000);
  if (!dialog) return { ok: false, error: 'The resource picker did not open.' };
  const search = dialog.querySelector<HTMLInputElement>('input[placeholder*="search" i]');
  if (!search) return { ok: false, error: 'The resource picker has no search field. CivitAI’s UI may have changed.' };
  // Retain a useful manual search when the site's callback/API contract has changed.
  setNativeValue(search, name);
  search.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  const id = crypto.randomUUID();
  search.setAttribute(GENERATOR_RESOURCE_TARGET_ATTR, id);
  const result = await new Promise<GeneratorResourceResult>((resolve) => {
    const finish = (result: GeneratorResourceResult) => {
      clearTimeout(timeout);
      window.removeEventListener(GENERATOR_RESOURCE_RESULT_EVENT, onResult);
      // Removing this marker also prevents a late metadata response from selecting anything.
      search.removeAttribute(GENERATOR_RESOURCE_TARGET_ATTR);
      resolve(result);
    };
    const onResult = (event: Event) => {
      try {
        const result = JSON.parse((event as CustomEvent).detail) as GeneratorResourceResult;
        if (result.id === id) finish(result);
      } catch { /* unrelated or malformed page event */ }
    };
    const timeout = setTimeout(() => finish({ id, ok: false, unknown: true,
      error: 'No acknowledgement from the resource picker. Check the page before retrying; refresh CivitAI after reloading the extension.' }), 15_000);
    window.addEventListener(GENERATOR_RESOURCE_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent(GENERATOR_RESOURCE_SET_EVENT, { detail: JSON.stringify({ id, versionId, weight }) }));
  });
  if (!result.ok) return result;
  // A callback returning is not proof that React kept the change. Verify the exact version
  // link in Additional Resources, and the requested weight in that resource's own row.
  const applied = await waitFor(() => {
    const link = resourceLink();
    if (!link || openResourceDialog()) return null;
    if (weight === undefined) return true;
    let row: HTMLElement | null = link;
    for (let depth = 0; row && row !== resourceSection() && depth < 9; depth++, row = row.parentElement) {
      const links = [...row.querySelectorAll<HTMLAnchorElement>('a[href*="modelVersionId="]')];
      if (links.some((item) => Number(new URL(item.href, location.href).searchParams.get('modelVersionId')) !== versionId)) break;
      const inputs = [...row.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"], input[inputmode="decimal"], input[type="number"]')];
      if (inputs.some((input) => input.value.trim() && Number(input.value) === weight)) return true;
    }
    return null;
  }, 4000);
  return applied ? { ok: true } : { ok: false, unknown: true,
    error: `CivitAI did not confirm version ${versionId}${weight !== undefined ? ` at weight ${weight}` : ''} in Additional Resources. Check the page before retrying.` };
}

/** Switch the seed control to Custom and set the value. */
function setSeed(value: number): boolean {
  const wrap = findLabeledWrapper(/^seed/i);
  if (!wrap) return false;
  wrap.querySelector<HTMLInputElement>('input[type="radio"][value="custom"]')?.click();
  const input = wrap.querySelector<HTMLInputElement>(
    'input:not([type="radio"]):not([type="checkbox"])'
  );
  if (!input) return false;
  setNativeValue(input, String(value));
  return true;
}

/**
 * Detect if the generation form is present on the page.
 */
export function detectForm(): boolean {
  return allPromptEditors().some((e) => /prompt/.test(editorContext(e)));
}

/**
 * Whether we're literally on the /generate route. Use this only for "the form should be
 * here and isn't" contract checks — for anything user-facing use isGeneratorAvailable().
 */
export function isOnGeneratePath(): boolean {
  return window.location.pathname.startsWith(GENERATE_PATH);
}

/**
 * Whether the generation form is reachable right now.
 *
 * The URL alone is not enough: CivitAI's generator also opens as a drawer over any page
 * (feed, profile, model page), where the full form is live in the DOM while the path stays
 * e.g. /user/foo/images. Gating Apply on the path alone made the extension refuse to work
 * in exactly that case, so fall back to detecting the form itself.
 */
export function isGeneratorAvailable(): boolean {
  return isOnGeneratePath() || detectForm();
}

/**
 * Read the current state of all form fields.
 */
export function readFormState(): FormState {
  const state: FormState = {
    prompt: '',
    negativePrompt: '',
  };

  const promptEl = findPromptEditor('prompt');
  if (promptEl) state.prompt = promptEl.innerText.trim();
  const negEl = findPromptEditor('negativePrompt');
  if (negEl) state.negativePrompt = negEl.innerText.trim();

  // NB: use Number.isFinite, not `|| undefined`, so a legit 0 (e.g. seed 0) isn't dropped.
  const finite = (n: number) => (Number.isFinite(n) ? n : undefined);
  state.cfgScale = readLabeledNumber(FIELD_LABELS.cfgScale, parseFloat);
  state.steps = readLabeledNumber(FIELD_LABELS.steps, (s) => parseInt(s, 10));
  state.clipSkip = readLabeledNumber(FIELD_LABELS.clipSkip, (s) => parseInt(s, 10));

  const samplerEl = findLabeledInput(FIELD_LABELS.sampler);
  if (samplerEl?.value) state.sampler = samplerEl.value;

  const radios = aspectRadios();
  const aspect = radios.find((r) => r.checked);
  if (aspect) state.aspectRatio = aspect.value;
  // Which ratios exist depends on the loaded model — tell the LLM so it can't recommend one
  // the form doesn't have.
  if (radios.length) state.availableAspectRatios = radios.map((r) => r.value);

  const seedEl = findLabeledWrapper(/^seed/i)?.querySelector<HTMLInputElement>(
    'input:not([type="radio"]):not([type="checkbox"])'
  );
  if (seedEl?.value) state.seed = finite(parseInt(seedEl.value, 10));

  const durations = durationRadios();
  const pickedDuration = durations.find((r) => r.checked);
  if (pickedDuration) {
    state.duration = Number(pickedDuration.value);
  } else {
    state.duration = readLabeledNumber(/^duration/i, parseFloat);
  }
  if (durations.length) state.availableDurations = durations.map((r) => Number(r.value));

  const resolutions = resolutionRadios();
  const pickedResolution = resolutions.find((r) => r.checked);
  if (pickedResolution) state.resolution = pickedResolution.value;
  if (resolutions.length) state.availableResolutions = resolutions.map((r) => r.value);

  const generateAudio = findGenerateAudioInput();
  if (generateAudio) state.generateAudio = generateAudio.checked;

  const videoWorkflow = detectVideoWorkflow();
  if (videoWorkflow) state.videoWorkflow = videoWorkflow;
  const generatorImages = getGeneratorImages();
  if (generatorImages.length) state.generatorImages = generatorImages;
  const imageSlots = availableGeneratorImageSlots();
  if (imageSlots.length) state.availableGeneratorImageSlots = imageSlots;

  const ranges: NonNullable<FormState['parameterRanges']> = {};
  const collectRange = (
    key: keyof NonNullable<FormState['parameterRanges']>,
    re: RegExp
  ) => {
    const range = numericRange(re);
    if (range) ranges[key] = range;
  };
  collectRange('cfgScale', FIELD_LABELS.cfgScale);
  collectRange('steps', FIELD_LABELS.steps);
  collectRange('clipSkip', FIELD_LABELS.clipSkip);
  collectRange('duration', /^duration/i);
  if (Object.keys(ranges).length) state.parameterRanges = ranges;

  const modelLink = findLabeledWrapper(/^model/i)?.querySelector('a');
  if (modelLink?.textContent?.trim()) state.model = modelLink.textContent.trim();
  if (modelLink?.getAttribute('href')) {
    try {
      const url = new URL(modelLink.getAttribute('href')!, location.href);
      const modelId = Number(url.pathname.match(/^\/models\/(\d+)(?:\/|$)/)?.[1]);
      const versionId = Number(url.searchParams.get('modelVersionId'));
      if (Number.isSafeInteger(modelId) && modelId > 0) state.modelId = modelId;
      if (Number.isSafeInteger(versionId) && versionId > 0) state.modelVersionId = versionId;
    } catch { /* A non-URL model label provides no authoritative identity. */ }
  }

  // Which controls this model actually renders. The form is heavily model-dependent —
  // a distilled checkpoint may expose nothing but prompt/aspect/steps/seed — and anything
  // the LLM proposes for a missing field is silently dropped on Apply.
  const available = ['prompt'];
  if (negEl) available.push('negativePrompt');
  for (const key of Object.keys(FIELD_LABELS)) {
    if (findLabeledInput(FIELD_LABELS[key]) || findLabeledSlider(FIELD_LABELS[key])) {
      available.push(key);
    }
  }
  if (radios.length) available.push('aspectRatio');
  if (seedEl) available.push('seed');
  if (durations.length || findLabeledInput(/^duration/i) || findLabeledSlider(/^duration/i)) {
    available.push('duration');
  }
  if (resolutions.length) available.push('resolution');
  if (generateAudio) available.push('generateAudio');
  if (imageSlots.length) available.push('sourceImages');
  if (resourceSection()) available.push('loraResources');
  state.availableFields = available;

  return state;
}

/**
 * Set a prompt field value (positive or negative prompt).
 * Returns false when the target editor can't be found (form contract break).
 */
export function setPrompt(field: 'prompt' | 'negativePrompt', value: string): boolean {
  const el = findPromptEditor(field);
  if (!el) return false;
  setContentEditableValue(el, value);
  return true;
}

/**
 * Set a generation parameter value. Returns false when the field isn't on the form —
 * which is often legitimate (param availability is model-dependent), so callers decide
 * whether a miss is noteworthy.
 */
export function setParameter(field: string, value: string | number | boolean): boolean {
  if (field === 'aspectRatio') return setAspectRatio(String(value));
  if (field === 'seed') return setSeed(Number(value));
  if (field === 'duration') return setDuration(String(value));
  if (field === 'resolution') return setResolution(String(value));
  if (field === 'generateAudio') {
    const enabled =
      typeof value === 'boolean'
        ? value
        : /^(?:true|yes|on|1)$/i.test(String(value).trim());
    return setGenerateAudio(enabled);
  }
  const re = FIELD_LABELS[field];
  if (!re) return false;
  if (field === 'sampler') {
    const input = findLabeledInput(re);
    if (!input) return false;
    setNativeValue(input, String(value));
    return true;
  }
  return setLabeledNumber(re, value as string | number);
}

function visibleButtonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
      const rect = button.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        button.textContent?.trim() === text
      );
    }) ?? null
  );
}

async function selectVideoWorkflow(workflow: VideoWorkflow): Promise<boolean> {
  if (detectVideoWorkflow() === workflow) return true;
  const button = visibleButtonWithText(VIDEO_WORKFLOW_COPY[workflow].title);
  if (!button) return false;
  button.click();
  return !!(await waitFor(() => detectVideoWorkflow() === workflow, 5000));
}

function imageInputForSlot(slot: GeneratorImageSlot): HTMLInputElement | null {
  const inputs = generatorImageInputs();
  if (slot === 'reference') {
    return (
      inputs.find((input) => /\d+\s+of\s+\d+\s+images/i.test(generatorImageInputContext(input))) ??
      (detectVideoWorkflow() === 'referenceToVideo' ? inputs[0] : null)
    );
  }
  if (slot === 'firstFrame') {
    return (
      inputs.find((input) => /\bfirst\s+frame\b/i.test(generatorImageInputContext(input))) ??
      (inputs.length === 1 ? inputs[0] : null)
    );
  }
  if (slot === 'lastFrame') {
    return inputs.find((input) => /\blast\s+frame\b/i.test(generatorImageInputContext(input))) ?? null;
  }
  return (
    inputs.find(
      (input) => !/\b(?:first|last)\s+frame\b/i.test(generatorImageInputContext(input))
    ) ??
    inputs.find((input) => /\bfirst\s+frame\b/i.test(generatorImageInputContext(input))) ??
    null
  );
}

function imageFileName(name: string | undefined, type: string): string {
  const fallbackExt = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const safe = (name || `chat-image.${fallbackExt}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : `${safe}.${fallbackExt}`;
}

/**
 * Upload a numbered chat image into the correct video-workflow slot.
 * The action never submits generation; it only switches the visible workflow and drives
 * CivitAI's real file input, which performs the site's normal validation/upload.
 */
export async function applyGeneratorImage(
  url: string,
  slot: GeneratorImageSlot,
  name?: string
): Promise<{ ok: boolean; error?: string }> {
  const workflow: VideoWorkflow =
    slot === 'reference' ? 'referenceToVideo' : 'imageToVideo';
  if (!(await selectVideoWorkflow(workflow))) {
    return { ok: false, error: `Could not switch CivitAI to ${VIDEO_WORKFLOW_COPY[workflow].title}.` };
  }

  const effectiveSlot: GeneratorImageSlot =
    slot === 'source' && availableGeneratorImageSlots().includes('firstFrame')
      ? 'firstFrame'
      : slot;
  if (
    effectiveSlot !== 'reference' &&
    getGeneratorImages().some((image) => image.slot === effectiveSlot)
  ) {
    return {
      ok: false,
      error: `${effectiveSlot === 'source' ? 'The source image slot' : `The ${effectiveSlot} slot`} is already filled. Remove it on CivitAI first.`,
    };
  }

  const input = await waitFor(() => imageInputForSlot(slot), 5000);
  if (!input) {
    return {
      ok: false,
      error: `This model does not expose a ${slot} image slot in the current video workflow.`,
    };
  }

  let blob: Blob;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image request returned HTTP ${response.status}`);
    blob = await response.blob();
  } catch (err) {
    return {
      ok: false,
      error: `Could not read the selected chat image: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type.toLowerCase())) {
    return {
      ok: false,
      error: `CivitAI's video source accepts PNG, JPEG, or WebP; this attachment is ${blob.type || 'an unknown format'}.`,
    };
  }

  const before = getGeneratorImages().length;
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], imageFileName(name, blob.type), { type: blob.type }));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set?.call(
    input,
    transfer.files
  );
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const result = await waitFor(() => {
    if (getGeneratorImages().length > before) return { ok: true as const };
    const error = [...document.querySelectorAll<HTMLElement>('[class*="Card-root"] p')].find(
      (element) => /requirement|invalid|unsupported|failed/i.test(element.textContent ?? '')
    );
    return error?.textContent ? { ok: false as const, error: error.textContent.trim() } : null;
  }, 15000);
  return result ?? {
    ok: false,
    error: 'CivitAI did not finish loading the image into the generator.',
  };
}

/**
 * The structural site contract of the generate form: every DOM shape the bridge relies on,
 * checked cheaply. Returns human-readable descriptions of MISSING pieces (empty = healthy).
 * Only pieces present in every generator mode/model belong here — model-dependent params
 * (CFG, sampler, clip skip…) are deliberately excluded.
 */
export function formContractIssues(): string[] {
  const issues: string[] = [];
  if (!document.querySelector('[class*="InputWrapper-root"]'))
    issues.push('Mantine InputWrapper containers (field targeting is label-based)');
  if (!findPromptEditor('prompt')) issues.push('the ProseMirror prompt editor');
  const submit =
    document.querySelector(SELECTORS.submitButton) ??
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent?.trim().toLowerCase() === 'generate'
    );
  if (!submit) issues.push('the Generate submit button');
  return issues;
}

/** The visible element representing a field, for highlightField. */
function findFieldElement(field: string): HTMLElement | null {
  if (field === 'prompt' || field === 'negativePrompt') return findPromptEditor(field);
  if (field === 'aspectRatio') {
    return aspectRadios()[0]?.closest<HTMLElement>('[class*="SegmentedControl-root"]') ?? null;
  }
  if (field === 'duration') {
    return (
      durationRadios()[0]?.parentElement ??
      findLabeledSlider(/^duration/i) ??
      findLabeledInput(/^duration/i)
    );
  }
  if (field === 'resolution') {
    return resolutionRadios()[0]?.closest<HTMLElement>('[role="radiogroup"]') ?? null;
  }
  if (field === 'generateAudio') return findGenerateAudioInput();
  if (field === 'seed') return findLabeledWrapper(/^seed/i);
  const re = FIELD_LABELS[field];
  return re ? findLabeledInput(re) : null;
}

/**
 * Highlight a form field briefly after its value has been set.
 */
export function highlightField(field: string): void {
  const el = findFieldElement(field);
  if (!el) return;

  el.style.transition = 'box-shadow 0.3s ease';
  el.style.boxShadow = '0 0 8px 2px rgba(52, 152, 219, 0.6)';

  setTimeout(() => {
    el.style.boxShadow = '';
  }, 1500);
}

/** Click the Generate/submit button on the /generate page. Returns false if not found. */
export function submitGenerate(): boolean {
  const btn =
    document.querySelector<HTMLElement>(SELECTORS.submitButton) ??
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent?.trim().toLowerCase() === 'generate'
    ) ??
    null;
  if (!btn) return false;
  btn.click();
  return true;
}

/** Civitai serves gallery images from this CDN host (downscaled transcodes are fine for vision). */
function isCivitaiMedia(src: string): boolean {
  return /image\.civitai\.com/.test(src);
}

function renderedArea(img: HTMLImageElement): number {
  const r = img.getBoundingClientRect();
  return r.width * r.height;
}

/**
 * URL of the most prominent Civitai image currently shown (image detail page or feed lightbox),
 * or null. Picks the largest rendered Civitai-CDN <img>, ignoring avatars/icons.
 */
export function getOpenImageUrl(): string | null {
  const imgs = [...document.querySelectorAll('img')].filter((img) => {
    const src = img.currentSrc || img.src;
    const r = img.getBoundingClientRect();
    return !!src && isCivitaiMedia(src) && r.width > 64 && r.height > 64;
  });
  if (!imgs.length) return null;
  imgs.sort((a, b) => renderedArea(b) - renderedArea(a));
  return imgs[0].currentSrc || imgs[0].src;
}

/** URLs of the currently-visible Civitai images (largest first, deduped) — for grabbing several. */
export function getVisibleImageUrls(limit = 8): string[] {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const imgs = [...document.querySelectorAll('img')].filter((img) => {
    const src = img.currentSrc || img.src;
    const r = img.getBoundingClientRect();
    return (
      !!src && isCivitaiMedia(src) &&
      r.width > 80 && r.height > 80 &&
      r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw // fully within the viewport box
    );
  });
  imgs.sort((a, b) => renderedArea(b) - renderedArea(a));
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const img of imgs) {
    const u = img.currentSrc || img.src;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= limit) break;
  }
  return urls;
}

/**
 * Watch for the generation form to appear/disappear (SPA navigation).
 * Uses MutationObserver with debouncing.
 */
export function watchForForm(callback: (detected: boolean) => void): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDetected = false;

  const check = () => {
    const detected = detectForm();
    if (detected !== lastDetected) {
      lastDetected = detected;
      callback(detected);
    }
  };

  const debouncedCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(check, 300);
  };

  // Initial check
  check();

  // Observe DOM changes
  const observer = new MutationObserver(debouncedCheck);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Also check on URL changes (for SPA)
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    debouncedCheck();
  };

  window.addEventListener('popstate', debouncedCheck);
}
