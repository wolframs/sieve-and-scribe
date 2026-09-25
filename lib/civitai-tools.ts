/**
 * Civitai data tools — the live-lookup layer.
 *
 * Exposes a small set of OpenAI-style function tools that let the LLM look up
 * real LoRAs, trigger words, and example prompts from the Civitai REST API
 * instead of guessing. The tool schemas are advertised to the model via the
 * chat-completions `tools` param; `executeCivitaiTool` runs the actual fetch.
 *
 * The side panel routes these through the active CivitAI content script so
 * catalog requests use that host and its browser session. An optional API token
 * is also supported; neither a token nor an NSFW flag guarantees content access.
 *
 * The recipes here mirror .claude/skills/sdxl-prompt-craft/references/loras.md.
 */

interface CatalogRequest {
  origin: string;
  token?: string;
  signal?: AbortSignal;
}

/** Only trusted CivitAI origins may receive the configured token. */
export function civitaiCatalogOrigin(origin?: string): string {
  const candidate = origin ?? globalThis.location?.origin;
  if (!candidate || (!origin && !/^https:\/\/(?:www\.)?civitai\.(?:com|red)$/.test(candidate))) return 'https://civitai.com';
  if (!/^https:\/\/(?:www\.)?civitai\.(?:com|red)$/.test(candidate)) throw new Error('Unsupported CivitAI catalog origin.');
  return candidate;
}

/** OpenAI function-tool definition shape. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Tool schemas advertised to the model. */
export const CIVITAI_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_civitai_loras',
      description:
        'Search Civitai for LoRAs (or other models) by keyword and base-model family. ' +
        'Use this to discover LoRAs for a character, style, or concept the user wants. ' +
        'Returns the top matches with their model id and compatible versionId (needed by the ' +
        'other tools), trigger words when available, a description snippet, sample image ' +
        'URLs, and a Civitai link. IMPORTANT: each result carries `supportsGeneration`. ' +
        'When it is false the LoRA CANNOT be used in Civitai\'s on-site image generator at ' +
        'all — do not recommend such a result for generation; prefer a result with ' +
        'supportsGeneration true, and say so explicitly if only unsupported ones exist. ' +
        'Defaults to on-site generation-supported versions. Prefer checkpointVersionId from the form to resolve its exact base automatically. ' +
        'If a keyword search on a known base is empty, this tool also tries that same base without keywords once and labels the broader results. Do not drop compatibility filters or repeat the same empty search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional search keywords. Omit to discover available LoRAs on the chosen base without restricting style.',
          },
          baseModel: {
            type: 'string',
            description:
              'Exact CivitAI base-model identifier from metadata or get_civitai_base_models; all current families are accepted. ' +
              'Prefer checkpointVersionId when available. A display label such as Flux.2 does not identify a specific variant.',
          },
          checkpointVersionId: { type: 'integer', description: 'Version ID of the loaded CHECKPOINT from the current form. Resolves the exact base model through CivitAI metadata; do not guess this ID.' },
          supportsGeneration: { type: 'boolean', description: 'Default true: return only versions verified as supported by the on-site generator. Set false only for download-only research.' },
          type: {
            type: 'string',
            enum: ['LORA', 'Checkpoint', 'LoCon', 'TextualInversion'],
            description: 'Model type to search. Defaults to LORA.',
          },
          sort: {
            type: 'string',
            enum: ['Most Downloaded', 'Highest Rated', 'Newest'],
            description:
              'Result ordering. Use "Newest" when the user asks for recent or just-released ' +
              'LoRAs, "Highest Rated" for quality over popularity. Defaults to "Most Downloaded".',
          },
          limit: {
            type: 'integer',
            description: 'How many results to return (1-10). Default 6.',
          },
          nsfw: {
            type: 'boolean',
            description: 'Include mature results. Defaults to true on the active civitai.red tab, false otherwise. Explicit false requests safe results. Account browsing settings and server access rules still apply.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_civitai_base_models',
      description: 'Read the current exact base-model names accepted by CivitAI. Use when checkpoint metadata is unavailable; never infer variant compatibility from a display label or parameter ranges.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Optional family substring, e.g. Flux.2. Returns matching exact identifiers.' },
      } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_civitai_model',
      description:
        'Get full details for a Civitai model by its numeric id, including every version with ' +
        'its exact trigger words (trainedWords), base model, per-version description (where ' +
        'authors document recommended LoRA weights and usage notes), per-version ' +
        'supportsGeneration, stats, and sample image URLs. Use this to fetch reliable trigger ' +
        'words and recommended weights before putting a LoRA in a prompt. A version with ' +
        'supportsGeneration false cannot be used in Civitai\'s on-site generator.',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'integer', description: 'The numeric Civitai model id (from search results).' },
        },
        required: ['modelId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mine_civitai_prompts',
      description:
        'Fetch real, highly-rated example images made with a specific model version, to ' +
        'reverse-engineer what prompts and settings work well. Use the modelVersionId from search ' +
        'or get_civitai_model. Returns positive/negative prompts, generation params (seed, size, ' +
        'sampler, cfg, steps, base model) and an imageUrl for every example. Requests prompt metadata explicitly. ' +
        'Missing metadata can reflect uploader omissions or access limits; do not infer a missing token from an empty examples array. ' +
        'Use returned image URLs to inspect examples when their prompt text is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          modelVersionId: {
            type: 'integer',
            description: 'The numeric model VERSION id (not the model id).',
          },
          limit: { type: 'integer', description: 'How many example images (1-10). Default 5.' },
          nsfw: { type: 'boolean', description: 'Include mature images. Defaults to true on civitai.red, false otherwise; explicit false is respected. Server access rules still apply.' },
        },
        required: ['modelVersionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_civitai_articles',
      description:
        'Search Civitai articles — community tutorials, guides, model announcements, and ' +
        'prompting write-ups. This is how you look up how-to knowledge you do not already ' +
        'have, e.g. "how to prompt Illustrious", "LoRA training guide", "Flux workflow". ' +
        'Search returns TITLES AND METADATA ONLY, never the article text — you must call ' +
        'get_civitai_article with the returned id to actually read one.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search keywords, e.g. "Illustrious prompting guide" or "LoRA weights".',
          },
          limit: { type: 'integer', description: 'How many articles to return (1-10). Default 5.' },
          nsfw: { type: 'boolean', description: 'Include mature articles. Defaults to true on civitai.red, false otherwise; explicit false is respected. Server access rules still apply.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_civitai_article',
      description:
        'Read the full text of one Civitai article by its numeric id (from ' +
        'search_civitai_articles). This is the only way to read a tutorial or guide — the ' +
        'search tool returns titles only. Returns the article body as plain text, truncated ' +
        'if very long.',
      parameters: {
        type: 'object',
        properties: {
          articleId: {
            type: 'integer',
            description: 'The numeric Civitai article id (from search_civitai_articles).',
          },
        },
        required: ['articleId'],
      },
    },
  },
];

/** Whether the model has any usable tools given current settings. */
export function civitaiToolsAvailable(enabled: boolean): boolean {
  // Public and browser-session access can work without an API token.
  // Availability follows the user's enable toggle.
  return enabled;
}

interface CivitaiArgs {
  query?: string;
  baseModel?: string;
  checkpointVersionId?: number;
  supportsGeneration?: boolean;
  type?: string;
  sort?: string;
  limit?: number;
  nsfw?: boolean;
  modelId?: number;
  modelVersionId?: number;
  articleId?: number;
}

/** Sort values accepted by `search_civitai_loras`, mapped onto the Civitai API. */
const LORA_SORTS = ['Most Downloaded', 'Highest Rated', 'Newest'] as const;

/**
 * Execute a Civitai tool call. `argsJson` is the raw arguments string from the
 * model's tool_call. Returns a compact JSON string for feeding back to the model.
 * Never throws — failures are returned as `{ error }` so the model can recover.
 */
export async function executeCivitaiTool(
  name: string,
  argsJson: string,
  token?: string,
  signal?: AbortSignal,
  origin?: string,
): Promise<string> {
  let args: CivitaiArgs;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an object');
  } catch {
    return JSON.stringify({ error: `Could not parse arguments: ${argsJson}` });
  }

  let source: Record<string, unknown> | undefined;
  try {
    const request: CatalogRequest = { origin: civitaiCatalogOrigin(origin), token, signal };
    if (args.nsfw !== undefined && typeof args.nsfw !== 'boolean') return JSON.stringify({ error: 'nsfw must be a boolean.' });
    args.nsfw ??= new URL(request.origin).hostname.endsWith('civitai.red');
    const filtersContent = ['search_civitai_loras', 'mine_civitai_prompts', 'search_civitai_articles'].includes(name);
    source = { origin: request.origin, nsfwRequested: filtersContent ? args.nsfw : null, tokenConfigured: Boolean(token),
      browserSession: globalThis.location?.origin === request.origin ? 'sent if present' : 'unavailable',
      accessNote: 'Content availability still depends on account browsing settings and server access rules. Empty results alone do not prove an authentication or content-filter block.' };
    const encode = (result: Record<string, unknown>) => JSON.stringify({ ...result, source });
    switch (name) {
      case 'get_civitai_base_models': {
        const enums = await civitaiFetch('/enums', request);
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        return encode({ baseModels: (enums.BaseModel ?? []).filter((name: unknown) =>
          typeof name === 'string' && name.toLowerCase().includes(query)) });
      }
      case 'search_civitai_loras':
        return encode(await searchLoras(args, request));
      case 'get_civitai_model':
        return encode(await getModel(args, request));
      case 'mine_civitai_prompts':
        return encode(await minePrompts(args, request));
      case 'search_civitai_articles':
        return encode(await searchArticles(args, request));
      case 'get_civitai_article':
        return encode(await getArticle(args, request));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), source });
  }
}

async function civitaiFetch(
  path: string,
  request: CatalogRequest,
): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (request.token) headers.Authorization = `Bearer ${request.token}`;

  const res = await fetch(`${request.origin}/api/v1${path}`, { headers, signal: request.signal, credentials: 'same-origin', redirect: 'error' });
  if (!res.ok) {
    throw new Error(`Civitai API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return res.json();
}

/** Split Civitai's sometimes-messy trainedWords into clean trigger tokens. */
function cleanTriggers(trained: unknown): string[] {
  if (!Array.isArray(trained)) return [];
  return trained
    .flatMap((w) => (typeof w === 'string' ? w.split(',') : []))
    .map((w) => w.trim().replace(/,+$/, ''))
    .filter(Boolean);
}

function clampLimit(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(10, v));
}

/**
 * Civitai descriptions and article bodies are HTML. Flatten to plain text and
 * cap the length so a single verbose author cannot eat the model's context.
 */
function stripHtml(html: unknown, maxChars: number): string | undefined {
  if (typeof html !== 'string') return undefined;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Pull up to `max` usable image URLs off a model version's images[]. */
function sampleImageUrls(images: unknown, max: number): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .map((img: any) => (typeof img?.url === 'string' ? img.url : undefined))
    .filter((u): u is string => Boolean(u))
    .slice(0, max);
}

async function searchLoras(args: CivitaiArgs, request: CatalogRequest) {
  let baseModel = args.baseModel;
  if (args.checkpointVersionId !== undefined) {
    if (!Number.isSafeInteger(args.checkpointVersionId) || args.checkpointVersionId <= 0) return { error: 'checkpointVersionId must be a positive integer from the current form.' };
    const checkpoint = await civitaiFetch(`/model-versions/${args.checkpointVersionId}`, request);
    if (typeof checkpoint.baseModel !== 'string' || !checkpoint.baseModel) return { error: 'The checkpoint metadata did not supply an exact base model.' };
    if (baseModel && baseModel !== checkpoint.baseModel) return { error: 'The requested base model differs from the loaded checkpoint.', requestedBaseModel: baseModel, checkpointBaseModel: checkpoint.baseModel };
    baseModel = checkpoint.baseModel;
  }
  const supportedOnly = args.supportsGeneration !== false;
  const params = new URLSearchParams();
  params.set('types', args.type || 'LORA');
  if (args.query) params.set('query', args.query);
  if (baseModel) params.set('baseModels', baseModel);
  if (supportedOnly) params.set('supportsGeneration', 'true');
  const sort = LORA_SORTS.includes(args.sort as any) ? (args.sort as string) : 'Most Downloaded';
  params.set('sort', sort);
  params.set('limit', String(clampLimit(args.limit, 6)));
  params.set('nsfw', String(args.nsfw === true));

  let data = await civitaiFetch(`/models?${params.toString()}`, request);
  const selectVersion = (model: any) => (model.modelVersions ?? []).find((version: any) =>
    (!baseModel || version.baseModel === baseModel) && (!supportedOnly || version.supportsGeneration === true));
  let items: any[] = (data.items ?? []).filter((model: any) => selectVersion(model));
  const searchAttempts = [{ keywordApplied: Boolean(args.query), apiModelCount: (data.items ?? []).length, compatibleModelCount: items.length }];
  let keywordFallback = false;
  if (!items.length && args.query && baseModel) {
    // One bounded fallback retains exact compatibility and generation support.
    params.delete('query');
    data = await civitaiFetch(`/models?${params.toString()}`, request);
    items = (data.items ?? []).filter((model: any) => selectVersion(model));
    searchAttempts.push({ keywordApplied: false, apiModelCount: (data.items ?? []).length, compatibleModelCount: items.length });
    keywordFallback = true;
  }

  const results = items.map((m) => {
    const v0 = selectVersion(m);
    return {
      name: m.name,
      modelId: m.id,
      latestVersionId: m.modelVersions?.[0]?.id,
      versionId: v0?.id,
      versionName: v0?.name,
      baseModel: v0?.baseModel,
      type: m.type,
      // Whether this version can be used in Civitai's on-site generator at all.
      supportsGeneration: v0?.supportsGeneration ?? null,
      description: stripHtml(m.description, 300),
      downloads: m.stats?.downloadCount,
      thumbsUp: m.stats?.thumbsUpCount,
      thumbsDown: m.stats?.thumbsDownCount,
      publishedAt: v0?.publishedAt,
      triggerWords: cleanTriggers(v0?.trainedWords),
      sampleImageUrls: sampleImageUrls(v0?.images, 2),
      nsfw: m.nsfw,
      url: `${request.origin}/models/${m.id}`,
    };
  });

  return {
    baseModel: baseModel ?? null,
    checkpointVersionId: args.checkpointVersionId,
    supportsGenerationOnly: supportedOnly,
    keywordFallback,
    searchAttempts,
    nextCursor: data.metadata?.nextCursor,
    count: results.length,
    results,
    ...(results.length === 0
      ? { hint: 'No compatible versions were found in this bounded search. This is not proof none exist. Do not repeat identical searches or drop the base-model constraint; explain the limitation and offer a different style or checkpoint.' }
      : keywordFallback ? { hint: 'The keyword search found no compatible versions. These are broader results on the same exact base; do not claim they match the requested style without inspecting them. Use versionId, not latestVersionId.' }
      : { hint: 'Use versionId for the compatible version; latestVersionId may refer to a different base model.' }),
  };
}

async function getModel(args: CivitaiArgs, request: CatalogRequest) {
  if (!args.modelId) return { error: 'modelId is required' };
  const m = await civitaiFetch(`/models/${args.modelId}`, request);
  return {
    name: m.name,
    modelId: m.id,
    type: m.type,
    nsfw: m.nsfw,
    tags: m.tags,
    creator: m.creator?.username,
    stats: {
      downloads: m.stats?.downloadCount,
      thumbsUp: m.stats?.thumbsUpCount,
      thumbsDown: m.stats?.thumbsDownCount,
      comments: m.stats?.commentCount,
    },
    description: stripHtml(m.description, 1200),
    versions: (m.modelVersions ?? []).slice(0, 6).map((v: any) => ({
      versionId: v.id,
      name: v.name,
      baseModel: v.baseModel,
      baseModelType: v.baseModelType,
      // False means this version cannot be used in Civitai's on-site generator.
      supportsGeneration: v.supportsGeneration,
      triggerWords: cleanTriggers(v.trainedWords),
      promptInstruction: cleanTriggers(v.trainedWords).length
        ? `Copy these exact trigger words into the positive prompt: ${cleanTriggers(v.trainedWords).join(', ')}`
        : 'This version reports no trigger words; do not invent any.',
      // Authors usually document recommended LoRA weights in here.
      description: stripHtml(v.description, 400),
      publishedAt: v.publishedAt,
      stats: {
        downloads: v.stats?.downloadCount,
        thumbsUp: v.stats?.thumbsUpCount,
        thumbsDown: v.stats?.thumbsDownCount,
      },
      sampleImageUrls: sampleImageUrls(v.images, 3),
    })),
    url: `${request.origin}/models/${m.id}`,
  };
}

async function minePrompts(args: CivitaiArgs, request: CatalogRequest) {
  if (!args.modelVersionId) return { error: 'modelVersionId is required' };
  const params = new URLSearchParams();
  params.set('modelVersionId', String(args.modelVersionId));
  params.set('withMeta', 'true');
  params.set('sort', 'Most Reactions');
  params.set('limit', String(clampLimit(args.limit, 5)));
  params.set('nsfw', String(args.nsfw === true));

  const data = await civitaiFetch(`/images?${params.toString()}`, request);
  const items: any[] = data.items ?? [];

  // Every image URL, whether or not it carried prompt metadata — a picture the
  // model can actually look at beats an empty result.
  const imageUrls = items
    .map((img) => (typeof img?.url === 'string' ? img.url : undefined))
    .filter((u): u is string => Boolean(u));

  const examples = items
    .filter((img) => img.meta && (img.meta.prompt || img.meta.negativePrompt))
    .map((img) => {
      const meta = img.meta;
      return {
        imageUrl: img.url,
        prompt: meta.prompt,
        negative: meta.negativePrompt,
        sampler: meta.sampler,
        cfgScale: meta.cfgScale,
        steps: meta.steps,
        seed: meta.seed ?? meta.Seed,
        size: meta.Size ?? (img.width && img.height ? `${img.width}x${img.height}` : undefined),
        width: img.width,
        height: img.height,
        baseModel: img.baseModel ?? meta.baseModel,
        clipSkip: meta.clipSkip ?? meta['Clip skip'],
        loras: Array.isArray(meta.civitaiResources)
          ? meta.civitaiResources
              .filter((r: any) => r.type === 'lora')
              .map((r: any) => ({ name: r.modelVersionName, weight: r.weight }))
          : undefined,
      };
    });

  if (examples.length === 0) {
    // Two very different situations that must not look alike to the model.
    if (items.length === 0) {
      return {
        count: 0,
        examples: [],
        imageUrls: [],
        hint:
          'Civitai returned no images at all for this modelVersionId. Check the id is a ' +
          'model VERSION id (not a model id), or try nsfw: true if the examples may be NSFW.',
      };
    }
    return {
      count: 0,
      examples: [],
      imageCount: imageUrls.length,
      imageUrls,
      hint:
        `Civitai returned ${imageUrls.length} example image(s) for this version, but none ` +
        'carried prompt metadata, although withMeta=true was requested. The uploader may have omitted it, or access limits may apply. ' +
        'This does not establish a missing API token or a content block. Use the image URLs to inspect the examples if useful.',
    };
  }

  return {
    count: examples.length,
    examples,
    imageCount: imageUrls.length,
    imageUrls,
  };
}

async function searchArticles(args: CivitaiArgs, request: CatalogRequest) {
  if (!args.query) return { error: 'query is required' };
  const params = new URLSearchParams();
  params.set('query', args.query);
  params.set('limit', String(clampLimit(args.limit, 5)));
  params.set('nsfw', String(args.nsfw === true));

  const data = await civitaiFetch(`/articles?${params.toString()}`, request);
  const items: any[] = data.items ?? [];

  const results = items.map((a) => ({
    id: a.id,
    title: a.title,
    publishedAt: a.publishedAt,
    tags: Array.isArray(a.tags)
      ? a.tags.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
      : [],
    viewCount: a.stats?.viewCount,
    likeCount: a.stats?.likeCount,
    author: a.user?.username,
    nsfwLevel: a.nsfwLevel,
    url: `${request.origin}/articles/${a.id}`,
  }));

  return {
    count: results.length,
    results,
    ...(results.length === 0
      ? { hint: 'No articles matched. Try broader or fewer keywords.' }
      : {
          hint:
            'These are titles only — the article text is NOT included. Call ' +
            'get_civitai_article with an id above to read one.',
        }),
  };
}

const ARTICLE_MAX_CHARS = 6000;

async function getArticle(args: CivitaiArgs, request: CatalogRequest) {
  if (!args.articleId) return { error: 'articleId is required' };
  const a = await civitaiFetch(`/articles/${args.articleId}`, request);

  const full = stripHtml(a.content, Number.MAX_SAFE_INTEGER);
  const content = full ? full.slice(0, ARTICLE_MAX_CHARS) : undefined;
  const truncated = Boolean(full && full.length > ARTICLE_MAX_CHARS);

  return {
    id: a.id,
    title: a.title,
    publishedAt: a.publishedAt,
    tags: Array.isArray(a.tags)
      ? a.tags.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
      : [],
    author: a.user?.username,
    url: `${request.origin}/articles/${a.id}`,
    content,
    truncated,
    ...(truncated
      ? { truncationNote: `Body truncated to the first ${ARTICLE_MAX_CHARS} characters.` }
      : {}),
    ...(content ? {} : { hint: 'This article returned no readable body content.' }),
  };
}
