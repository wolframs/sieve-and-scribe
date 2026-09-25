import { describe, expect, it, vi } from 'vitest';
import { executePageTool, pageToolsForForm, type PageToolDeps } from '@/lib/page-tools';

function deps(): PageToolDeps {
  return {
    getContext: vi.fn(() => ({})),
    getPageImages: vi.fn(() => []),
    getChatImages: vi.fn(() => [
      { number: 2, url: 'data:image/png;base64,abc', name: 'start.png' },
    ]),
    getGeneratorImages: vi.fn(() => [
      { slot: 'firstFrame', url: 'https://orchestration-new.civitai.com/frame.jpg' },
    ]),
  };
}

describe('image-aware page tools', () => {
  it('creates one bounded question card and normalizes duplicate options', async () => {
    const result = await executePageTool('ask_user', JSON.stringify({
      question: '  Which direction?  ',
      options: ['Neon anime', 'neon ANIME', 'Documentary real', '', 'Something else'],
    }), deps());

    expect(result.card).toEqual({
      kind: 'question',
      question: 'Which direction?',
      options: ['Neon anime', 'Documentary real', 'Something else'],
    });
    expect(JSON.parse(result.result).status).toBe('awaiting_user');
  });

  it('rejects a question with fewer than two distinct choices', async () => {
    const result = await executePageTool(
      'ask_user',
      JSON.stringify({ question: 'Which?', options: ['Same', 'same'] }),
      deps()
    );
    expect(JSON.parse(result.result).error).toContain('two distinct');
    expect(result.card).toBeUndefined();
  });

  it('views an exact numbered chat image with a matching vision label', async () => {
    const result = await executePageTool(
      'view_chat_image',
      JSON.stringify({ imageNumber: 2 }),
      deps()
    );

    expect(JSON.parse(result.result)).toMatchObject({ attached: 1, imageNumber: 2 });
    expect(result.images).toEqual([
      { url: 'data:image/png;base64,abc', label: 'Image 2' },
    ]);
  });

  it('builds a user-confirmed source-image card without mutating the page', async () => {
    const result = await executePageTool(
      'propose_source_image',
      JSON.stringify({ imageNumber: 2, slot: 'lastFrame' }),
      deps()
    );

    expect(result.card).toEqual({
      kind: 'sourceImage',
      imageNumber: 2,
      url: 'data:image/png;base64,abc',
      name: 'start.png',
      slot: 'lastFrame',
    });
    expect(JSON.parse(result.result)).toMatchObject({
      status: 'proposed',
      imageNumber: 2,
      slot: 'lastFrame',
    });
  });

  it('labels images already loaded in generator slots', async () => {
    const result = await executePageTool('view_generator_images', '{}', deps());

    expect(JSON.parse(result.result)).toMatchObject({
      attached: 1,
      slots: ['firstFrame'],
    });
    expect(result.images?.[0].label).toContain('first frame');
  });

  it('advertises only prompt controls exposed by the active form', () => {
    const promptTool = pageToolsForForm({
      prompt: '',
      negativePrompt: '',
      availableFields: ['prompt', 'steps', 'aspectRatio'],
    }).find((tool) => tool.function.name === 'propose_prompt');
    const properties = (promptTool?.function.parameters as any).properties;

    expect(Object.keys(properties)).toEqual(['positive', 'steps', 'aspectRatio']);
  });

  it('filters out stale or invented controls when creating a prompt proposal', async () => {
    const result = await executePageTool(
      'propose_prompt',
      JSON.stringify({
        positive: 'rainy Berlin portrait',
        negative: 'blur',
        steps: 28,
        aspectRatio: '2:3',
        sampler: 'DPM++ 2M Karras',
        duration: 10,
        generateAudio: false,
      }),
      {
        ...deps(),
        getFormState: vi.fn(() => ({
          prompt: '',
          negativePrompt: '',
          availableFields: ['prompt', 'steps', 'aspectRatio'],
        })),
      }
    );

    expect(result.card).toEqual({
      kind: 'prompt',
      positive: 'rainy Berlin portrait',
      negative: undefined,
      params: { steps: 28, aspectRatio: '2:3' },
    });
  });

  it('proposes a facet-only feed filter without mutating the page', async () => {
    const result = await executePageTool(
      'propose_feed_filter',
      JSON.stringify({
        creatorsInclude: ['@Alice'],
        orientations: ['portrait'],
        minReactions: 100,
        hasMeta: true,
      }),
      deps()
    );

    expect(result.card).toEqual({
      kind: 'feedFilter',
      tags: [],
      mode: 'all',
      facets: {
        creatorsInclude: ['alice'],
        creatorsExclude: [],
        orientations: ['portrait'],
        resourcesInclude: [],
        resourcesExclude: [],
        minReactions: 100,
        hasMeta: true,
      },
    });
    expect(JSON.parse(result.result)).toMatchObject({ status: 'proposed' });
  });

  it('rejects an empty feed-filter proposal', async () => {
    const result = await executePageTool('propose_feed_filter', '{}', deps());
    expect(JSON.parse(result.result).error).toContain('at least one');
    expect(result.card).toBeUndefined();
  });

  it('keeps lookup-grounded model version references in a feed proposal', async () => {
    const result = await executePageTool(
      'propose_feed_filter',
      JSON.stringify({
        primaryModel: { versionId: 501, label: 'Dream Model — v3' },
        resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
        resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
      }),
      deps()
    );
    expect(result.card).toMatchObject({
      kind: 'feedFilter',
      facets: {
        primaryModel: { versionId: 501, label: 'Dream Model — v3' },
        resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
        resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
      },
    });
  });
});
