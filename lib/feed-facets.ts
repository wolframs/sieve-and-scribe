export type FeedOrientation = 'portrait' | 'square' | 'landscape';

export interface FeedResourceRef {
  versionId: number;
  label: string;
}

export interface FeedFacetFilter {
  creatorsInclude: string[];
  creatorsExclude: string[];
  orientations: FeedOrientation[];
  primaryModel?: FeedResourceRef;
  resourcesInclude: FeedResourceRef[];
  resourcesExclude: FeedResourceRef[];
  minReactions?: number;
  minViews?: number;
  minComments?: number;
  minCollections?: number;
  hasMeta?: boolean;
  onSite?: boolean;
}

export const EMPTY_FEED_FACETS: FeedFacetFilter = {
  creatorsInclude: [],
  creatorsExclude: [],
  orientations: [],
  resourcesInclude: [],
  resourcesExclude: [],
};

const PARAMS = {
  creator: 'ffcreator',
  creatorNegative: 'ffcreatorneg',
  orientation: 'fforientation',
  primaryModel: 'ffprimarymodel',
  resource: 'ffresource',
  resourceNegative: 'ffresourceneg',
  minReactions: 'ffminreactions',
  minViews: 'ffminviews',
  minComments: 'ffmincomments',
  minCollections: 'ffmincollections',
  hasMeta: 'ffhasmeta',
  onSite: 'ffonsite',
} as const;

export const FEED_FACET_PARAMS = Object.values(PARAMS);

export function normalizeFeedFacetFilter(value: Partial<FeedFacetFilter> | null | undefined): FeedFacetFilter {
  const orientations = unique(
    (Array.isArray(value?.orientations) ? value.orientations : []).filter(
      (orientation): orientation is FeedOrientation =>
        orientation === 'portrait' || orientation === 'square' || orientation === 'landscape'
    )
  );
  const primaryModel = normalizeResource(value?.primaryModel);
  return {
    creatorsInclude: normalizeCreators(value?.creatorsInclude),
    creatorsExclude: normalizeCreators(value?.creatorsExclude),
    orientations,
    ...(primaryModel ? { primaryModel } : {}),
    resourcesInclude: normalizeResources(value?.resourcesInclude),
    resourcesExclude: normalizeResources(value?.resourcesExclude),
    ...positiveMinimums(value),
    ...(value?.hasMeta === true ? { hasMeta: true } : {}),
    ...(value?.onSite === true ? { onSite: true } : {}),
  };
}

export function parseFeedFacetsFromSearch(search: string): FeedFacetFilter {
  const params = new URLSearchParams(search);
  return normalizeFeedFacetFilter({
    creatorsInclude: params.getAll(PARAMS.creator),
    creatorsExclude: params.getAll(PARAMS.creatorNegative),
    orientations: params.getAll(PARAMS.orientation) as FeedOrientation[],
    primaryModel: parseResource(params.get(PARAMS.primaryModel)),
    resourcesInclude: params.getAll(PARAMS.resource).map(parseResource).filter(isResourceRef),
    resourcesExclude: params.getAll(PARAMS.resourceNegative).map(parseResource).filter(isResourceRef),
    minReactions: readPositiveInteger(params.get(PARAMS.minReactions)),
    minViews: readPositiveInteger(params.get(PARAMS.minViews)),
    minComments: readPositiveInteger(params.get(PARAMS.minComments)),
    minCollections: readPositiveInteger(params.get(PARAMS.minCollections)),
    hasMeta: params.get(PARAMS.hasMeta) === '1',
    onSite: params.get(PARAMS.onSite) === '1',
  });
}

export function writeFeedFacetsToUrl(url: URL, value: Partial<FeedFacetFilter> | null | undefined): URL {
  for (const param of FEED_FACET_PARAMS) url.searchParams.delete(param);
  const facets = normalizeFeedFacetFilter(value);
  for (const creator of facets.creatorsInclude) url.searchParams.append(PARAMS.creator, creator);
  for (const creator of facets.creatorsExclude) url.searchParams.append(PARAMS.creatorNegative, creator);
  for (const orientation of facets.orientations) url.searchParams.append(PARAMS.orientation, orientation);
  if (facets.primaryModel) url.searchParams.set(PARAMS.primaryModel, serializeResource(facets.primaryModel));
  for (const resource of facets.resourcesInclude) url.searchParams.append(PARAMS.resource, serializeResource(resource));
  for (const resource of facets.resourcesExclude) url.searchParams.append(PARAMS.resourceNegative, serializeResource(resource));
  writeNumber(url, PARAMS.minReactions, facets.minReactions);
  writeNumber(url, PARAMS.minViews, facets.minViews);
  writeNumber(url, PARAMS.minComments, facets.minComments);
  writeNumber(url, PARAMS.minCollections, facets.minCollections);
  if (facets.hasMeta) url.searchParams.set(PARAMS.hasMeta, '1');
  if (facets.onSite) url.searchParams.set(PARAMS.onSite, '1');
  return url;
}

export function feedFacetCount(value: Partial<FeedFacetFilter> | null | undefined): number {
  const facets = normalizeFeedFacetFilter(value);
  return (
    facets.creatorsInclude.length +
    facets.creatorsExclude.length +
    facets.orientations.length +
    Number(facets.primaryModel !== undefined) +
    facets.resourcesInclude.length +
    facets.resourcesExclude.length +
    Number(facets.minReactions !== undefined) +
    Number(facets.minViews !== undefined) +
    Number(facets.minComments !== undefined) +
    Number(facets.minCollections !== undefined) +
    Number(facets.hasMeta === true) +
    Number(facets.onSite === true)
  );
}

export function hasFeedFacets(value: Partial<FeedFacetFilter> | null | undefined): boolean {
  return feedFacetCount(value) > 0;
}

export function sameFeedFacets(
  left: Partial<FeedFacetFilter> | null | undefined,
  right: Partial<FeedFacetFilter> | null | undefined
): boolean {
  return JSON.stringify(normalizeFeedFacetFilter(left)) === JSON.stringify(normalizeFeedFacetFilter(right));
}

export function feedFacetSummary(value: Partial<FeedFacetFilter> | null | undefined): string {
  const facets = normalizeFeedFacetFilter(value);
  const parts: string[] = [];
  if (facets.orientations.length) parts.push(facets.orientations.map(capitalize).join('/'));
  if (facets.primaryModel) parts.push(facets.primaryModel.label);
  if (facets.resourcesInclude.length) parts.push(`${facets.resourcesInclude.length} resource${facets.resourcesInclude.length === 1 ? '' : 's'}`);
  if (facets.resourcesExclude.length) parts.push(`${facets.resourcesExclude.length} resource exclusion${facets.resourcesExclude.length === 1 ? '' : 's'}`);
  if (facets.minReactions !== undefined) parts.push(`≥${facets.minReactions} reactions`);
  if (facets.minViews !== undefined) parts.push(`≥${facets.minViews} views`);
  if (facets.minComments !== undefined) parts.push(`≥${facets.minComments} comments`);
  if (facets.minCollections !== undefined) parts.push(`≥${facets.minCollections} collections`);
  if (facets.creatorsInclude.length) parts.push(`${facets.creatorsInclude.length} creator${facets.creatorsInclude.length === 1 ? '' : 's'}`);
  if (facets.creatorsExclude.length) parts.push(`${facets.creatorsExclude.length} creator exclusion${facets.creatorsExclude.length === 1 ? '' : 's'}`);
  if (facets.hasMeta) parts.push('Has generation data');
  if (facets.onSite) parts.push('Generated on CivitAI');
  return parts.join(' · ');
}

export function matchesFeedFacets(item: any, value: Partial<FeedFacetFilter> | null | undefined): boolean {
  const facets = normalizeFeedFacetFilter(value);
  const username = normalizeCreator(item?.user?.username ?? item?.username);
  if (facets.creatorsInclude.length && (!username || !facets.creatorsInclude.includes(username))) return false;
  if (username && facets.creatorsExclude.includes(username)) return false;

  if (facets.orientations.length) {
    const orientation = orientationOf(item?.width, item?.height);
    if (!orientation || !facets.orientations.includes(orientation)) return false;
  }

  const primaryVersionId = positiveInteger(item?.modelVersionId);
  if (facets.primaryModel && primaryVersionId !== facets.primaryModel.versionId) return false;
  const versionIds = new Set<number>([
    ...(Array.isArray(item?.modelVersionIds) ? item.modelVersionIds.map(positiveInteger) : []),
    primaryVersionId,
  ].filter((id): id is number => id !== undefined));
  if (facets.resourcesInclude.length && !facets.resourcesInclude.some((resource) => versionIds.has(resource.versionId))) {
    return false;
  }
  if (facets.resourcesExclude.some((resource) => versionIds.has(resource.versionId))) return false;

  if (!meetsMinimum(reactionCount(item), facets.minReactions)) return false;
  if (!meetsMinimum(metric(item, 'viewCountAllTime', 'viewCount'), facets.minViews)) return false;
  if (!meetsMinimum(metric(item, 'commentCountAllTime', 'commentCount'), facets.minComments)) return false;
  if (!meetsMinimum(metric(item, 'collectedCountAllTime', 'collectedCount'), facets.minCollections)) return false;
  if (facets.hasMeta && item?.hasMeta !== true && item?.meta == null) return false;
  if (facets.onSite && item?.onSite !== true) return false;
  return true;
}

function positiveMinimums(value: Partial<FeedFacetFilter> | null | undefined): Partial<FeedFacetFilter> {
  const out: Partial<FeedFacetFilter> = {};
  for (const key of ['minReactions', 'minViews', 'minComments', 'minCollections'] as const) {
    const parsed = readPositiveInteger(value?.[key]);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

function normalizeCreators(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return unique(values.map(normalizeCreator).filter((value): value is string => !!value));
}

function normalizeResources(values: unknown): FeedResourceRef[] {
  if (!Array.isArray(values)) return [];
  const out: FeedResourceRef[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const resource = normalizeResource(value);
    if (!resource || seen.has(resource.versionId)) continue;
    seen.add(resource.versionId);
    out.push(resource);
  }
  return out;
}

function normalizeResource(value: unknown): FeedResourceRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<FeedResourceRef>;
  const versionId = positiveInteger(candidate.versionId);
  if (!versionId) return undefined;
  const label = typeof candidate.label === 'string'
    ? candidate.label.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  return { versionId, label: label || `Version #${versionId}` };
}

function parseResource(value: string | null): FeedResourceRef | undefined {
  if (!value) return undefined;
  const separator = value.indexOf('|');
  const idPart = separator === -1 ? value : value.slice(0, separator);
  return normalizeResource({
    versionId: Number(idPart),
    label: separator === -1 ? '' : value.slice(separator + 1),
  });
}

function serializeResource(value: FeedResourceRef): string {
  return `${value.versionId}|${value.label.replace(/[\r\n|]+/g, ' ').trim().slice(0, 120)}`;
}

function isResourceRef(value: FeedResourceRef | undefined): value is FeedResourceRef {
  return value !== undefined;
}

function normalizeCreator(value: unknown): string | undefined {
  const creator = typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : '';
  return creator || undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function writeNumber(url: URL, param: string, value: number | undefined): void {
  if (value !== undefined) url.searchParams.set(param, String(value));
}

function orientationOf(width: unknown, height: unknown): FeedOrientation | undefined {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  const ratio = w / h;
  if (ratio >= 0.95 && ratio <= 1.05) return 'square';
  return ratio < 1 ? 'portrait' : 'landscape';
}

function reactionCount(item: any): number | undefined {
  const stats = item?.stats;
  const keys = ['likeCountAllTime', 'laughCountAllTime', 'heartCountAllTime', 'cryCountAllTime', 'dislikeCountAllTime'];
  const values = keys.map((key) => finiteNumber(stats?.[key]));
  if (values.some((value) => value !== undefined)) return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return finiteNumber(item?.reactionCount ?? stats?.reactionCount);
}

function metric(item: any, allTimeKey: string, fallbackKey: string): number | undefined {
  return finiteNumber(item?.stats?.[allTimeKey] ?? item?.[fallbackKey] ?? item?.stats?.[fallbackKey]);
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function meetsMinimum(actual: number | undefined, minimum: number | undefined): boolean {
  return minimum === undefined || (actual !== undefined && actual >= minimum);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
