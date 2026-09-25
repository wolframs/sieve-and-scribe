import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGeneratorImage,
  getGeneratorImages,
  readFormState,
  setParameter,
  setPrompt,
} from '@/entrypoints/civitai.content/dom-bridge';
import {
  GENERATOR_PROMPT_RESULT_EVENT,
  GENERATOR_PROMPT_SET_EVENT,
  GENERATOR_PROMPT_TARGET_ATTR,
} from '@/lib/generator-page-bridge';

function addPromptEditors() {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `
      <div class="mantine-InputWrapper-root">
        <label>Prompt</label>
        <div class="ProseMirror" contenteditable="true" data-placeholder="Your prompt goes here..."></div>
      </div>
      <div class="mantine-InputWrapper-root">
        <label>Negative Prompt</label>
        <div class="ProseMirror" contenteditable="true" data-placeholder="What to avoid..."></div>
      </div>
    `
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

it('reads checkpoint identity from the model link without inferring a variant from its label', () => {
  addPromptEditors();
  document.body.insertAdjacentHTML('beforeend', `<div class="mantine-InputWrapper-root">
    <label>Model</label><a href="https://civitai.com/models/2165902?modelVersionId=2439067">Flux.2</a>
  </div>`);
  expect(readFormState()).toMatchObject({ model: 'Flux.2', modelId: 2165902, modelVersionId: 2439067 });
  document.querySelector('a')!.setAttribute('href', '/models/2165902?modelVersionId=invalid');
  expect(readFormState().modelVersionId).toBeUndefined();
});

describe('image-to-video source controls', () => {
  it('reports a standard empty img2vid source slot', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div>
          <p>Image to Video</p>
          <p>Generate video from an image</p>
        </div>
        <div class="mantine-Dropzone-root">
          <span>Drop images here or click to select</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple>
        </div>
      `
    );

    expect(readFormState()).toMatchObject({
      videoWorkflow: 'imageToVideo',
      availableGeneratorImageSlots: ['source'],
    });
    expect(readFormState().availableFields).toContain('sourceImages');
    expect(getGeneratorImages()).toEqual([]);
  });

  it('distinguishes first and last-frame inputs without merging their parent context', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div>
          <p>Image to Video</p>
          <p>Generate video from an image</p>
        </div>
        <div class="frame-grid">
          <div class="mantine-Dropzone-root">
            <span>First Frame</span>
            <input type="file" accept="image/png,image/jpeg,image/webp">
          </div>
          <div class="mantine-Dropzone-root">
            <span>Last Frame (optional)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp">
          </div>
        </div>
      `
    );

    expect(readFormState().availableGeneratorImageSlots).toEqual([
      'firstFrame',
      'lastFrame',
    ]);
  });

  it('reads populated frame cards and labels them in visible slot order', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div>
          <p>Image to Video</p>
          <p>Generate video from an image</p>
        </div>
        <div class="frame-grid">
          <div class="mantine-Card-root">
            <img alt="image" src="https://orchestration-new.civitai.com/first.jpg">
            <span>1024 x 576</span>
            <button><svg class="tabler-icon icon-x"></svg></button>
          </div>
          <div class="mantine-Dropzone-root">
            <span>Last Frame (optional)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp">
          </div>
        </div>
      `
    );

    expect(getGeneratorImages()).toEqual([
      {
        slot: 'firstFrame',
        url: 'https://orchestration-new.civitai.com/first.jpg',
        width: 1024,
        height: 576,
      },
    ]);
  });

  it('reports reference-to-video images as a collection', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div>
          <p>Reference to Video</p>
          <p>Generate video using a reference image</p>
        </div>
        <div class="mantine-Card-root">
          <img alt="image" src="https://orchestration-new.civitai.com/ref.jpg">
          <button><svg class="tabler-icon icon-x"></svg></button>
        </div>
        <div class="mantine-Dropzone-root">
          <span>1 of 9 images</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple>
        </div>
      `
    );

    expect(readFormState()).toMatchObject({
      videoWorkflow: 'referenceToVideo',
      availableGeneratorImageSlots: ['reference'],
      generatorImages: [
        {
          slot: 'reference',
          url: 'https://orchestration-new.civitai.com/ref.jpg',
        },
      ],
    });
  });

  it('drives CivitAI-style file input upload without submitting generation', async () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div>
          <p>Image to Video</p>
          <p>Generate video from an image</p>
        </div>
        <div id="source-drop" class="mantine-Dropzone-root">
          <span>Drop images here or click to select</span>
          <input id="source-file" type="file" accept="image/png,image/jpeg,image/webp" multiple>
        </div>
      `
    );
    const input = document.querySelector<HTMLInputElement>('#source-file')!;
    input.addEventListener('change', () => {
      expect(input.files).toHaveLength(1);
      expect(input.files?.[0].name).toBe('Image 7.png');
      document.querySelector('#source-drop')!.outerHTML = `
        <div class="mantine-Card-root">
          <img alt="image" src="https://orchestration-new.civitai.com/uploaded.jpg">
          <span>512 x 512</span>
          <button><svg class="tabler-icon icon-x"></svg></button>
        </div>
      `;
    });

    const result = await applyGeneratorImage(
      'data:image/png;base64,iVBORw0KGgo=',
      'source',
      'Image 7.png'
    );

    expect(result).toEqual({ ok: true });
    expect(getGeneratorImages()[0]).toMatchObject({
      slot: 'source',
      url: 'https://orchestration-new.civitai.com/uploaded.jpg',
    });
  });
});

describe('prompt writes', () => {
  it('uses the synchronous MAIN-world bridge when the page-owned editor is isolated', () => {
    addPromptEditors();
    const positive = document.querySelector<HTMLElement>(
      '.ProseMirror[data-placeholder^="Your prompt"]'
    )!;
    const pageTransaction = vi.fn();
    const onRequest = (event: Event) => {
      const request = JSON.parse((event as CustomEvent).detail);
      expect(positive.getAttribute(GENERATOR_PROMPT_TARGET_ATTR)).toBe(request.id);
      pageTransaction(request.value);
      window.dispatchEvent(
        new CustomEvent(GENERATOR_PROMPT_RESULT_EVENT, {
          detail: JSON.stringify({ id: request.id, ok: true }),
        })
      );
    };
    window.addEventListener(GENERATOR_PROMPT_SET_EVENT, onRequest);

    try {
      expect(setPrompt('prompt', 'a page-world transaction')).toBe(true);
      expect(pageTransaction).toHaveBeenCalledWith('a page-world transaction');
      expect(positive.hasAttribute(GENERATOR_PROMPT_TARGET_ATTR)).toBe(false);
    } finally {
      window.removeEventListener(GENERATOR_PROMPT_SET_EVENT, onRequest);
    }
  });

  it('uses the live Tiptap editor command so the form state, not just the DOM, is updated', () => {
    addPromptEditors();
    const positive = document.querySelector<HTMLElement>(
      '.ProseMirror[data-placeholder^="Your prompt"]'
    )!;
    const negative = document.querySelector<HTMLElement>(
      '.ProseMirror[data-placeholder^="What to avoid"]'
    )!;
    const positiveSet = vi.fn();
    const negativeSet = vi.fn();
    Object.assign(positive, { editor: { commands: { setContent: positiveSet } } });
    Object.assign(negative, { editor: { commands: { setContent: negativeSet } } });

    expect(setPrompt('prompt', 'a cinematic fox')).toBe(true);
    expect(setPrompt('negativePrompt', 'blur, artifacts')).toBe(true);

    expect(positiveSet).toHaveBeenCalledWith('a cinematic fox');
    expect(negativeSet).toHaveBeenCalledWith('blur, artifacts');
  });
});

describe('graph-driven numeric controls', () => {
  it('reads and writes the visible NumberInput, not the slider hidden input, and clamps to its range', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div class="mantine-InputWrapper-root">
          <label><label>CFG Scale</label></label>
          <div>
            <div role="slider" aria-label="CFG Scale"
              aria-valuemin="0.1" aria-valuemax="1" aria-valuenow="0.5">
              <input id="cfg-hidden" type="hidden" value="0.5">
            </div>
            <div class="mantine-InputWrapper-root mantine-NumberInput-root">
              <input id="cfg-visible" type="text" inputmode="numeric"
                aria-label="CFG Scale" value="0.5">
            </div>
          </div>
        </div>
      `
    );
    const visible = document.querySelector<HTMLInputElement>('#cfg-visible')!;
    const inputSpy = vi.fn();
    visible.addEventListener('input', inputSpy);

    const before = readFormState();
    expect(before.cfgScale).toBe(0.5);
    expect(before.parameterRanges?.cfgScale).toEqual({ min: 0.1, max: 1 });
    expect(before.availableFields).toContain('cfgScale');

    expect(setParameter('cfgScale', 7)).toBe(true);
    expect(visible.value).toBe('1');
    expect(document.querySelector<HTMLInputElement>('#cfg-hidden')!.value).toBe('0.5');
    expect(inputSpy).toHaveBeenCalledOnce();
  });

  it('supports a ranged video duration NumberSlider', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div class="mantine-InputWrapper-root">
          <label>Duration (seconds)</label>
          <div role="slider" aria-label="Duration (seconds)"
            aria-valuemin="3" aria-valuemax="20" aria-valuenow="5"></div>
          <input type="hidden" value="5">
          <input id="duration-visible" type="text"
            aria-label="Duration (seconds)" value="5">
        </div>
      `
    );

    expect(readFormState().duration).toBe(5);
    expect(readFormState().parameterRanges?.duration).toEqual({ min: 3, max: 20 });
    expect(setParameter('duration', 12)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#duration-visible')!.value).toBe('12');
  });
});

describe('video option controls', () => {
  it('finds discrete duration/resolution groups by their nearby labels and toggles generated audio', () => {
    addPromptEditors();
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <div class="flex flex-col gap-1">
          <label>Duration</label>
          <div role="radiogroup">
            <div><input id="d5" type="radio" name="duration" value="5" checked><label for="d5">5 seconds</label></div>
            <div><input id="d10" type="radio" name="duration" value="10"><label for="d10">10 seconds</label></div>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label>Resolution</label>
          <div role="radiogroup">
            <div><input id="r720" type="radio" name="resolution" value="720p" checked><label for="r720">720p</label></div>
            <div><input id="r1080" type="radio" name="resolution" value="1080p"><label for="r1080">1080p</label></div>
          </div>
        </div>
        <div>
          <input id="audio" type="checkbox">
          <label for="audio">Generate audio</label>
        </div>
      `
    );

    expect(readFormState()).toMatchObject({
      duration: 5,
      availableDurations: [5, 10],
      resolution: '720p',
      availableResolutions: ['720p', '1080p'],
      generateAudio: false,
    });

    expect(setParameter('duration', 9)).toBe(true);
    expect(setParameter('resolution', '1080p')).toBe(true);
    expect(setParameter('generateAudio', true)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#d10')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#r1080')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#audio')!.checked).toBe(true);
  });
});
