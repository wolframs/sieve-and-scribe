import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'devalue';
import { decodeGenerationData, selectExactResource } from '@/lib/resource-picker';
import { GENERATOR_RESOURCE_TARGET_ATTR } from '@/lib/generator-page-bridge';

const resource = { id: 34, name: 'v1', baseModel: 'Pony', model: { id: 12, type: 'LORA', name: 'Style' }, canGenerate: true, hasAccess: true, minStrength: -1, maxStrength: 2, strength: 1 };
let target: HTMLInputElement;
let picker: any;
beforeEach(() => {
  document.body.innerHTML = '<input>';
  target = document.querySelector('input')!;
  target.setAttribute(GENERATOR_RESOURCE_TARGET_ATTR, 'test');
  picker = { selectSource: 'generation', resources: [{ type: 'LORA', baseModels: ['Pony'] }], excludedIds: [], filters: {}, onSelect: vi.fn() };
  (target as any).__reactFiber$test = { return: { memoizedProps: { value: picker } } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: { resources: [resource] } } } }))));
});
afterEach(() => vi.unstubAllGlobals());

it('decodes both tRPC transports without accepting a missing resources envelope', () => {
  expect(decodeGenerationData({ result: { data: stringify({ resources: [resource] }) } }).resources[0]).toEqual(resource);
  expect(decodeGenerationData([{ result: { data: { json: { resources: [resource] } } } }]).resources[0]).toEqual(resource);
  expect(() => decodeGenerationData({ error: { message: 'access denied' } })).toThrow('rejected');
  expect(() => decodeGenerationData({ result: { data: {} } })).toThrow('unexpected');
});

it('selects only the requested version at the requested strength', async () => {
  expect(await selectExactResource({ id: 'test', versionId: 34, weight: 0.7 })).toMatchObject({ ok: true });
  expect(picker.onSelect).toHaveBeenCalledExactlyOnceWith({ ...resource, strength: 0.7 });
  const url = new URL(vi.mocked(fetch).mock.calls[0][0] as URL);
  expect(url.pathname).toBe('/api/trpc/generation.getGenerationData');
  expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ json: { type: 'modelVersion', id: 34, withPreview: true } });
});

it.each([
  ['wrong version', { id: 99 }],
  ['unavailable', { canGenerate: false, substitute: { ...resource, id: 99 } }],
  ['no access', { hasAccess: false }],
  ['incompatible base', { baseModel: 'Illustrious' }],
  ['wrong type', { model: { type: 'Checkpoint' } }],
  ['weight out of range', { maxStrength: 0.5 }],
])('does not mutate for %s', async (_label, patch) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: { resources: [{ ...resource, ...patch }] } } } }))));
  expect(await selectExactResource({ id: 'test', versionId: 34, weight: 0.7 })).toMatchObject({ ok: false, error: expect.any(String) });
  expect(picker.onSelect).not.toHaveBeenCalled();
});

it.each([
  ['duplicate', { excludedIds: [34] }], ['staged batch', { staged: [resource] }], ['limit', { limit: 0 }],
])('does not disturb the picker with %s', async (_label, patch) => {
  Object.assign(picker, patch);
  expect(await selectExactResource({ id: 'test', versionId: 34 })).toMatchObject({ ok: false });
  expect(picker.onSelect).not.toHaveBeenCalled();
});

it('fails explicitly if CivitAI changes its UI or its API fails', async () => {
  delete (target as any).__reactFiber$test;
  expect(await selectExactResource({ id: 'test', versionId: 34 })).toMatchObject({ ok: false, error: expect.stringContaining('UI may have changed') });
  expect(fetch).not.toHaveBeenCalled();
  (target as any).__reactFiber$test = { memoizedProps: { value: picker } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  expect(await selectExactResource({ id: 'test', versionId: 34 })).toMatchObject({ ok: false, error: expect.stringContaining('503') });
});

it('cannot select after a timeout clears the target or a checkpoint changes during the lookup', async () => {
  for (const change of [() => target.removeAttribute(GENERATOR_RESOURCE_TARGET_ATTR), () => { picker.resources = []; }]) {
    target.setAttribute(GENERATOR_RESOURCE_TARGET_ATTR, 'test');
    vi.stubGlobal('fetch', vi.fn(async () => {
      change();
      return new Response(JSON.stringify({ result: { data: { json: { resources: [resource] } } } }));
    }));
    expect(await selectExactResource({ id: 'test', versionId: 34 })).toMatchObject({ ok: false });
    expect(picker.onSelect).not.toHaveBeenCalled();
  }
});

it('marks a callback failure as unknown rather than claiming no mutation happened', async () => {
  picker.onSelect.mockImplementation(() => { throw new Error('UI failed after mutation'); });
  expect(await selectExactResource({ id: 'test', versionId: 34 })).toMatchObject({ ok: false, unknown: true });
});
