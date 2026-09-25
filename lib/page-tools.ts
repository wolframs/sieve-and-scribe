/**
 * Agentic page-action tools.
 *
 * These let the LLM *act* on the Civitai page from the chat, following a read-free /
 * confirm-writes model:
 *  - Read tools (get_page_context) run immediately and return data.
 *  - Write tools (propose_*) never mutate the page directly — they return a "proposed"
 *    result to the model and emit a confirm **action card** into the chat. The change
 *    happens only when the user clicks Apply on that card.
 *
 * Same OpenAI function-schema shape as civitai-tools; dispatched alongside them in the
 * content script (which has DOM access). Page context is injected via `deps` so this
 * module stays DOM-agnostic.
 */
import type { ToolDefinition } from './civitai-tools';
import type { FormState, GenerationParams, GeneratorImage, GeneratorImageSlot } from './types';
import type { ChatImage } from './chat-images';
import { searchFeedTags, type FeedTag, type TagMode } from './civitai-feed-tags';
import {
  hasFeedFacets,
  normalizeFeedFacetFilter,
  type FeedFacetFilter,
} from './feed-facets';

/** A page change the LLM proposed; rendered as a confirm card and applied on user click. */
export type ProposedAction =
  | { kind: 'prompt'; positive: string; negative?: string; params?: GenerationParams }
  | { kind: 'feedFilter'; tags: FeedTag[]; mode: TagMode; facets: FeedFacetFilter }
  | { kind: 'navigate'; url: string; reason?: string }
  | { kind: 'resource'; versionId: number; name: string; weight?: number }
  | {
      kind: 'sourceImage';
      imageNumber: number;
      url: string;
      name?: string;
      slot: GeneratorImageSlot;
    }
  | {
      kind: 'mcpTool';
      toolName: string;
      args: Record<string, unknown>;
      title?: string;
      destructive?: boolean;
    }
  | { kind: 'question'; question: string; options: string[] }
  | { kind: 'generate' };

export interface PageToolDeps {
  /** Snapshot of the current page for the model to read (route, form, feed, open image). */
  getContext: () => unknown | Promise<unknown>;
  /** Live form capabilities used to validate a prompt proposal at execution time. */
  getFormState?: () => FormState | null | Promise<FormState | null>;
  /** URLs of images currently visible on the page (open image first), for the model to view. */
  getPageImages: (limit: number) => string[] | Promise<string[]>;
  /** Numbered images saved in this conversation, including older omitted attachments. */
  getChatImages: () => ChatImage[] | Promise<ChatImage[]>;
  /** Images already uploaded into the active CivitAI generator and their semantic slots. */
  getGeneratorImages: () => GeneratorImage[] | Promise<GeneratorImage[]>;
}

export const PAGE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask one material clarifying question before continuing. Use only when the answer changes the next action. Call this as the only tool in the round and wait for the selection. Include a "Something else — I’ll specify" option when the choices may not be exhaustive.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string', maxLength: 300 },
          options: {
            type: 'array', minItems: 2, maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_context',
      description:
        "Read what's on the Civitai page right now: the route; whether the Generate form is open and its current field values; the active image/video feed and any applied tag filters; and the URL of the image currently being viewed. Call this before proposing actions so your proposals fit the context.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_prompt',
      description:
        "Propose generation settings for the Civitai Generate form. This does NOT change the form directly — it shows the user an Apply card. Use on the /generate page. Provide a complete positive prompt; optionally a negative prompt and parameters.",
      parameters: {
        type: 'object',
        properties: {
          positive: { type: 'string', description: 'The positive prompt.' },
          negative: { type: 'string', description: 'The negative prompt (optional).' },
          cfgScale: {
            type: 'number',
            description: "CFG/guidance value. Use get_page_context first and stay inside this model's reported range.",
          },
          steps: { type: 'number' },
          sampler: { type: 'string' },
          seed: { type: 'number' },
          clipSkip: { type: 'number' },
          aspectRatio: { type: 'string', description: 'Ratio like "2:3" or "16:9". Use get_page_context and choose one the active model actually offers. A WxH resolution is mapped to the closest offered ratio.' },
          duration: { type: 'number', description: "Video only: clip length in seconds. Use the active model's reported options or numeric range." },
          resolution: { type: 'string', description: 'Video only: an offered output resolution such as "720p" or "1080p".' },
          generateAudio: { type: 'boolean', description: 'Video only: enable/disable generated audio when this control exists.' },
        },
        required: ['positive'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_source_image',
      description:
        'Propose using a numbered chat image as an image-to-video source, first frame, last frame, or reference image. Shows a thumbnail Apply card. Applying switches to the matching Image-to-Video/Reference-to-Video workflow when needed, then uploads the image; it never starts generation. Use view_chat_image first if you need to inspect an older image again.',
      parameters: {
        type: 'object',
        properties: {
          imageNumber: {
            type: 'integer',
            minimum: 1,
            description: 'The exact conversation-local Image N number shown in chat.',
          },
          slot: {
            type: 'string',
            enum: ['source', 'firstFrame', 'lastFrame', 'reference'],
            description:
              'source for a normal img2vid base image; firstFrame/lastFrame for models exposing those slots; reference for reference-to-video collections.',
          },
        },
        required: ['imageNumber', 'slot'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_feed_filter',
      description:
        "Propose filtering the image/video feed by tags and/or immediately available metadata. Shows an Apply card; it does not navigate until the user confirms. mode 'all' = every positive tag group; 'any' = any tag. Creator usernames, orientation, totals, and provenance can be used without tags. Include only filters the user actually requested; omit every unrequested optional field rather than filling placeholders or defaults.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag names, e.g. ["cyberpunk","forest"].' },
          mode: { type: 'string', enum: ['all', 'any'], description: 'Match ALL tags or ANY. Default "all".' },
          creatorsInclude: { type: 'array', items: { type: 'string' }, description: 'Only these CivitAI usernames.' },
          creatorsExclude: { type: 'array', items: { type: 'string' }, description: 'Exclude these CivitAI usernames.' },
          orientations: { type: 'array', items: { type: 'string', enum: ['portrait', 'square', 'landscape'] } },
          primaryModel: {
            type: 'object', additionalProperties: false,
            description: 'Require one exact primary CivitAI model version. Use an ID returned by CivitAI lookup.',
            properties: { versionId: { type: 'integer' }, label: { type: 'string' } },
            required: ['versionId', 'label'],
          },
          resourcesInclude: {
            type: 'array', maxItems: 8,
            description: 'Match when any listed model/resource version appears on the image. Use lookup-grounded IDs.',
            items: {
              type: 'object', additionalProperties: false,
              properties: { versionId: { type: 'integer' }, label: { type: 'string' } },
              required: ['versionId', 'label'],
            },
          },
          resourcesExclude: {
            type: 'array', maxItems: 8,
            description: 'Exclude images carrying any listed model/resource version. Use lookup-grounded IDs.',
            items: {
              type: 'object', additionalProperties: false,
              properties: { versionId: { type: 'integer' }, label: { type: 'string' } },
              required: ['versionId', 'label'],
            },
          },
          minReactions: { type: 'integer', description: 'Minimum total reactions. Omit unless explicitly requested; use 0 only if your tool serializer requires a value.' },
          minViews: { type: 'integer', description: 'Minimum views. Omit unless explicitly requested; use 0 only if your tool serializer requires a value.' },
          minComments: { type: 'integer', description: 'Minimum comments. Omit unless explicitly requested; use 0 only if your tool serializer requires a value.' },
          minCollections: { type: 'integer', description: 'Minimum collections. Omit unless explicitly requested; use 0 only if your tool serializer requires a value.' },
          hasMeta: { type: 'boolean', description: 'Require generation metadata. Omit unless requested.' },
          onSite: { type: 'boolean', description: 'Require images generated on CivitAI. Omit unless requested.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_page_images',
      description:
        "Fetch the images currently visible on the page — the image you're viewing, the latest generation results on /generate, or feed thumbnails — so you can actually SEE them. Use this whenever the user refers to images on the page ('this image', 'these results', 'what do you think of these').",
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 8, description: 'How many images to fetch (default 4).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_chat_image',
      description:
        'View one exact numbered image from this saved conversation. Use when the user refers to Image N and it is not present in the latest multimodal turn, or before choosing it as a video source.',
      parameters: {
        type: 'object',
        properties: {
          imageNumber: {
            type: 'integer',
            minimum: 1,
            description: 'The Image N number shown on the chat thumbnail.',
          },
        },
        required: ['imageNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_generator_images',
      description:
        'View the images already uploaded into the active CivitAI generator, labeled by source/first-frame/last-frame/reference slot. Call when page context reports generator images and you need to understand their visual content.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_generate',
      description:
        'Propose clicking the Generate button on the /generate page (after the prompt/params are set). Shows the user an Apply card; generation runs only if they click Apply.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_resource',
      description:
        "Attach a LoRA (or other resource) to the Generate form as a resource card with its own weight. This is the ONLY way a LoRA reaches CivitAI's generator — `<lora:name:weight>` text inside a prompt does NOTHING here and just pollutes the prompt. Shows the user an Apply card. Look the LoRA up first and check supportsGeneration is true; put its trigger words in the prompt text, not the LoRA reference. CivitAI hides resources whose base model doesn't match the loaded checkpoint, so match the base model of the model currently in the form.",
      parameters: {
        type: 'object',
        properties: {
          modelVersionId: {
            type: 'integer',
            description: 'The numeric model VERSION id (not the model id), from the lookup tools.',
          },
          name: {
            type: 'string',
            description: "The resource's display name from the lookup result. Apply selects the exact modelVersionId through CivitAI's resource picker.",
          },
          weight: {
            type: 'number',
            description: 'Starting weight (character 0.7-1.0, style 0.4-0.7, concept 0.5-0.8, detail 0.3-0.6). Default 1.0.',
          },
        },
        required: ['modelVersionId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_navigation',
      description:
        'Propose navigating to a Civitai page (must be a civitai.com URL or path). Shows the user an Apply card.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A civitai.com URL or path, e.g. "/generate" or "https://civitai.com/models".' },
          reason: { type: 'string', description: 'Short reason shown to the user (optional).' },
        },
        required: ['url'],
      },
    },
  },
];

const PROMPT_ARG_TO_FORM_FIELD: Record<string, string> = {
  negative: 'negativePrompt',
  cfgScale: 'cfgScale',
  steps: 'steps',
  sampler: 'sampler',
  seed: 'seed',
  clipSkip: 'clipSkip',
  aspectRatio: 'aspectRatio',
  duration: 'duration',
  resolution: 'resolution',
  generateAudio: 'generateAudio',
};

/**
 * Return page-tool schemas tailored to the active form. This reduces input tokens and,
 * more importantly, stops inviting the model to populate controls the loaded generator
 * does not expose. Runtime validation below remains the authority if the form changes.
 */
export function pageToolsForForm(formState?: FormState): ToolDefinition[] {
  const available = formState?.availableFields;
  if (!available?.length) return PAGE_TOOLS;
  const allowedFields = new Set(available);

  return PAGE_TOOLS.map((tool) => {
    if (tool.function.name !== 'propose_prompt') return tool;
    const parameters = tool.function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    const properties = Object.fromEntries(
      Object.entries(parameters.properties).filter(
        ([arg]) =>
          arg === 'positive' ||
          (PROMPT_ARG_TO_FORM_FIELD[arg] && allowedFields.has(PROMPT_ARG_TO_FORM_FIELD[arg]))
      )
    );
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: { ...parameters, properties },
      },
    };
  });
}

const PAGE_TOOL_NAMES = new Set(PAGE_TOOLS.map((t) => t.function.name));
export function isPageTool(name: string): boolean {
  return PAGE_TOOL_NAMES.has(name);
}

function pickParams(a: any, allowedFields?: Set<string>): GenerationParams | undefined {
  const p: GenerationParams = {};
  const permits = (field: string) => !allowedFields || allowedFields.has(field);
  if (permits('cfgScale') && typeof a.cfgScale === 'number') p.cfgScale = a.cfgScale;
  if (permits('steps') && typeof a.steps === 'number') p.steps = a.steps;
  if (permits('sampler') && typeof a.sampler === 'string') p.sampler = a.sampler;
  if (permits('seed') && typeof a.seed === 'number') p.seed = a.seed;
  if (permits('clipSkip') && typeof a.clipSkip === 'number') p.clipSkip = a.clipSkip;
  if (permits('aspectRatio') && typeof a.aspectRatio === 'string') p.aspectRatio = a.aspectRatio;
  if (permits('duration') && typeof a.duration === 'number') p.duration = a.duration;
  if (permits('resolution') && typeof a.resolution === 'string') p.resolution = a.resolution;
  if (permits('generateAudio') && typeof a.generateAudio === 'boolean') {
    p.generateAudio = a.generateAudio;
  }
  return Object.keys(p).length ? p : undefined;
}

/**
 * Execute a page tool. Reads run now; writes return a `card` to surface for confirmation.
 * The `result` string is what the model sees next turn.
 */
export async function executePageTool(
  name: string,
  argsJson: string,
  deps: PageToolDeps
): Promise<{
  result: string;
  card?: ProposedAction;
  images?: Array<{ url: string; label?: string }>;
}> {
  let args: any = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    /* leave args empty */
  }

  switch (name) {
    case 'ask_user': {
      const question = String(args.question ?? '').trim().slice(0, 300);
      const seen = new Set<string>();
      const rawOptions: unknown[] = Array.isArray(args.options) ? args.options : [];
      const options = rawOptions
        .map((option: unknown) => String(option).trim().slice(0, 120))
        .filter((option: string) => {
          const key = option.toLocaleLowerCase();
          if (!option || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 4);
      if (!question) return { result: JSON.stringify({ error: 'question is required' }) };
      if (options.length < 2) {
        return { result: JSON.stringify({ error: 'at least two distinct options are required' }) };
      }
      return {
        result: JSON.stringify({
          status: 'awaiting_user',
          note: 'The question is visible to the user. Wait for their selection before continuing.',
        }),
        card: { kind: 'question', question, options },
      };
    }

    case 'get_page_context':
      try {
        return { result: JSON.stringify(await deps.getContext()) };
      } catch {
        return { result: JSON.stringify({ error: 'could not read page context' }) };
      }

    case 'view_page_images': {
      const count = Math.max(1, Math.min(8, Number(args.count) || 4));
      const images = await deps.getPageImages(count);
      if (!images.length) return { result: JSON.stringify({ error: 'no images are visible on the page' }) };
      return {
        result: JSON.stringify({ attached: images.length }),
        images: images.map((url, index) => ({ url, label: `Page image ${index + 1}` })),
      };
    }

    case 'view_chat_image': {
      const imageNumber = Number(args.imageNumber);
      const image = (await deps.getChatImages()).find((candidate) => candidate.number === imageNumber);
      if (!image) {
        return {
          result: JSON.stringify({
            error: `Image ${Number.isFinite(imageNumber) ? imageNumber : '?'} is not in this conversation`,
          }),
        };
      }
      return {
        result: JSON.stringify({ attached: 1, imageNumber: image.number, name: image.name }),
        images: [{ url: image.url, label: `Image ${image.number}` }],
      };
    }

    case 'view_generator_images': {
      const images = await deps.getGeneratorImages();
      if (!images.length) {
        return {
          result: JSON.stringify({ error: 'no source/reference images are loaded in the generator' }),
        };
      }
      return {
        result: JSON.stringify({
          attached: images.length,
          slots: images.map((image) => image.slot),
        }),
        images: images.map((image, index) => ({
          url: image.url,
          label: `Generator ${generatorSlotLabel(image.slot)} ${index + 1}`,
        })),
      };
    }

    case 'propose_generate':
      return {
        result: JSON.stringify({ status: 'proposed', note: 'Shown as an Apply card; runs only if the user clicks Apply.' }),
        card: { kind: 'generate' },
      };

    case 'propose_prompt': {
      const positive = String(args.positive ?? '').trim();
      if (!positive) return { result: JSON.stringify({ error: 'positive prompt is required' }) };
      const formState = deps.getFormState
        ? await Promise.resolve(deps.getFormState()).catch(() => null)
        : null;
      const allowedFields = formState?.availableFields?.length
        ? new Set(formState.availableFields)
        : undefined;
      const card: ProposedAction = {
        kind: 'prompt',
        positive,
        negative:
          (!allowedFields || allowedFields.has('negativePrompt')) && typeof args.negative === 'string'
            ? args.negative
            : undefined,
        params: pickParams(args, allowedFields),
      };
      return {
        result: JSON.stringify({
          status: 'proposed',
          note: 'Shown to the user as an Apply card; the form changes only if they click Apply.',
        }),
        card,
      };
    }

    case 'propose_source_image': {
      const imageNumber = Number(args.imageNumber);
      const slot = args.slot as GeneratorImageSlot;
      const validSlots: GeneratorImageSlot[] = [
        'source',
        'firstFrame',
        'lastFrame',
        'reference',
      ];
      if (!Number.isInteger(imageNumber) || imageNumber <= 0) {
        return { result: JSON.stringify({ error: 'imageNumber must be a positive integer' }) };
      }
      if (!validSlots.includes(slot)) {
        return { result: JSON.stringify({ error: 'slot is required and must be a supported value' }) };
      }
      const image = (await deps.getChatImages()).find((candidate) => candidate.number === imageNumber);
      if (!image) {
        return {
          result: JSON.stringify({ error: `Image ${imageNumber} is not in this conversation` }),
        };
      }
      const card: ProposedAction = {
        kind: 'sourceImage',
        imageNumber,
        url: image.url,
        name: image.name,
        slot,
      };
      return {
        result: JSON.stringify({
          status: 'proposed',
          imageNumber,
          slot,
          note: 'Shown as a thumbnail Apply card; no upload happens until the user clicks Apply.',
        }),
        card,
      };
    }

    case 'propose_feed_filter': {
      const names: string[] = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const facets = normalizeFeedFacetFilter({
        creatorsInclude: Array.isArray(args.creatorsInclude) ? args.creatorsInclude.map(String) : [],
        creatorsExclude: Array.isArray(args.creatorsExclude) ? args.creatorsExclude.map(String) : [],
        orientations: Array.isArray(args.orientations) ? args.orientations as FeedFacetFilter['orientations'] : [],
        primaryModel: args.primaryModel as FeedFacetFilter['primaryModel'],
        resourcesInclude: Array.isArray(args.resourcesInclude)
          ? args.resourcesInclude as FeedFacetFilter['resourcesInclude']
          : [],
        resourcesExclude: Array.isArray(args.resourcesExclude)
          ? args.resourcesExclude as FeedFacetFilter['resourcesExclude']
          : [],
        minReactions: args.minReactions as number | undefined,
        minViews: args.minViews as number | undefined,
        minComments: args.minComments as number | undefined,
        minCollections: args.minCollections as number | undefined,
        hasMeta: args.hasMeta === true,
        onSite: args.onSite === true,
      });
      if (!names.length && !hasFeedFacets(facets)) {
        return { result: JSON.stringify({ error: 'provide at least one tag or metadata filter' }) };
      }
      // Resolve names in parallel; prefer an exact (case-insensitive) match over the top hit,
      // so "art" doesn't silently resolve to "art deco".
      const resolvedNullable = await Promise.all(
        names.slice(0, 8).map(async (n) => {
          const hits = await searchFeedTags(n).catch(() => [] as FeedTag[]);
          const exact = hits.find((h) => h.name.toLowerCase() === n.toLowerCase());
          return exact ?? hits[0] ?? null;
        })
      );
      const resolved = resolvedNullable.filter((t): t is FeedTag => !!t);
      if (names.length && !resolved.length && !hasFeedFacets(facets)) {
        return { result: JSON.stringify({ error: 'no matching tags found' }) };
      }
      const mode: TagMode = args.mode === 'any' ? 'any' : 'all';
      const card: ProposedAction = { kind: 'feedFilter', tags: resolved, mode, facets };
      return {
        result: JSON.stringify({ status: 'proposed', resolvedTags: resolved, mode, facets }),
        card,
      };
    }

    case 'propose_resource': {
      const versionId = Number(args.modelVersionId);
      const name = String(args.name ?? '').trim();
      if (!Number.isSafeInteger(versionId) || versionId <= 0) {
        return { result: JSON.stringify({ error: 'modelVersionId must be a positive number' }) };
      }
      if (!name) return { result: JSON.stringify({ error: 'name is required to label the resource suggestion' }) };
      const weight = typeof args.weight === 'number' && Number.isFinite(args.weight) ? args.weight : undefined;
      const card: ProposedAction = { kind: 'resource', versionId, name, weight };
      return {
        result: JSON.stringify({
          status: 'proposed',
          note: "Shown as an Apply card. Put the LoRA's trigger words in the prompt text — the LoRA itself rides on this resource card, not in the prompt.",
        }),
        card,
      };
    }

    case 'propose_navigation': {
      const url = String(args.url ?? '').trim();
      const ok = url.startsWith('/') || /^https?:\/\/(www\.)?civitai\.(com|red)(\/|$)/.test(url);
      if (!ok) return { result: JSON.stringify({ error: 'url must be a civitai.com URL or a path' }) };
      const card: ProposedAction = { kind: 'navigate', url, reason: typeof args.reason === 'string' ? args.reason : undefined };
      return { result: JSON.stringify({ status: 'proposed' }), card };
    }

    default:
      return { result: JSON.stringify({ error: `unknown page tool: ${name}` }) };
  }
}

function generatorSlotLabel(slot: GeneratorImageSlot): string {
  switch (slot) {
    case 'source':
      return 'source image';
    case 'firstFrame':
      return 'first frame';
    case 'lastFrame':
      return 'last frame';
    case 'reference':
      return 'reference image';
  }
}
