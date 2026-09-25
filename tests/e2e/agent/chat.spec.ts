import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const fixture = `<!doctype html><html><body><h1>CivitAI test fixture</h1>
  <div class="mantine-InputWrapper-root"><label>Prompt</label><div class="ProseMirror" contenteditable="true" data-placeholder="Your prompt goes here..."></div></div>
  <div class="mantine-InputWrapper-root"><label>Negative Prompt</label><div class="ProseMirror" contenteditable="true" data-placeholder="What to avoid..."></div></div>
  <button id="generate" onclick="window.generations=(window.generations||0)+1">Generate</button>
  </body></html>`;

const tool = (name: string, args: object = {}) => ({ choices: [{ delta: { tool_calls: [{
  index: 0, id: 'call-test', type: 'function', function: { name, arguments: JSON.stringify(args) },
}] }, finish_reason: 'tool_calls' }] });
const answer = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });

let context: BrowserContext, panel: Page, site: Page, worker: Worker;
let replies: Array<unknown | ((response: ServerResponse) => void)>;
let requests: any[], catalogUrls: string[], catalogStatus: number;
let releaseCatalog: (() => void) | undefined;
let catalogGate: Promise<void> | undefined;
let server: ReturnType<typeof createServer>;

test.beforeEach(async () => {
  replies = []; requests = []; catalogUrls = []; catalogStatus = 200; catalogGate = undefined;
  server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[]}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const reply = replies.shift();
    res.setHeader('Content-Type', 'text/event-stream');
    if (typeof reply === 'function') { reply(res); return; }
    res.end(`data: ${JSON.stringify(reply ?? { error: { message: 'Unexpected extra completion' } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const extension = resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 430, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Every remote site response is a fixture. Only the local mock provider is contacted.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === 'mcp.civitai.com') return route.fulfill({ json: { jsonrpc: '2.0', result: { tools: [] } } });
    if (url.hostname === 'civitai.red' && url.pathname.startsWith('/api/v1/')) {
      catalogUrls.push(url.href);
      if (catalogGate) await catalogGate;
      return route.fulfill({ status: catalogStatus, json: catalogStatus !== 200 ? { error: 'Fixture catalog unavailable' } :
        url.pathname.endsWith('/enums') ? { BaseModel: ['Pony', 'Illustrious'] } :
        { items: [{ id: 12, name: 'Fixture style', modelVersions: [{ id: 34, baseModel: 'Pony', supportsGeneration: true, trainedWords: ['fixture'] }] }] } });
    }
    if (url.hostname === 'civitai.red' && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: fixture });
    return route.fulfill({ status: 200, json: { data: [], items: [] } });
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async ({ port }) => {
    await chrome.storage.local.set({ cllpSettings: {
      activeProviderId: 'mock', providers: { mock: { type: 'custom', apiKey: 'test-only', baseURL: `http://127.0.0.1:${port}/v1`, defaultModel: 'mock-agent' } },
      systemPrompt: 'Exercise the tools.', temperature: 0, maxTokens: 512, civitaiApiToken: '', civitaiMcpMode: 'read', rollingContext: true, contextTurns: 20,
    }, cllpConversations: [], cllpActiveConversationId: null });
  }, { port });
  site = await context.newPage();
  await site.goto('https://civitai.red/models/fixture');
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split('/')[2]}/sidepanel.html`);
  await expect(panel.locator('.cllp-input')).toBeVisible();
  await site.bringToFront();
  await expect.poll(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return (await chrome.tabs.sendMessage(tab.id!, { type: 'cllp:page', op: 'route' }))?.ok; } catch { return false; }
  })).toBe(true);
});

test.afterEach(async ({}, testInfo) => {
  releaseCatalog?.(); releaseCatalog = undefined;
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: testInfo.outputPath('panel.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  }
  await context?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function send() {
  await panel.locator('.cllp-input').fill('Find a compatible style');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
}

test('catalog chain shows running and completed tools, saves history, and uses the red page bridge', async () => {
  catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  replies.push(tool('search_civitai_loras', { baseModel: 'Pony' }), answer('Found a compatible style.'));
  await send();
  await expect(panel.locator('.cllp-tool-row[data-status="running"]')).toBeVisible();
  await expect.poll(() => catalogUrls.length).toBe(1);
  releaseCatalog!();
  await expect(panel.locator('.cllp-tool-row[data-status="completed"]')).toBeVisible();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Found a compatible style.');
  expect(new URL(catalogUrls[0]).searchParams.get('nsfw')).toBe('true');
  expect(JSON.parse(requests[1].messages.find((m: any) => m.role === 'tool').content)).toMatchObject({ count: 1, source: { origin: 'https://civitai.red' } });
  await panel.reload();
  await expect(panel.locator('.cllp-tool-row[data-status="completed"]')).toBeVisible();
});

test('catalog failures remain visible and reach the model', async () => {
  catalogStatus = 503;
  replies.push(tool('get_civitai_base_models'), answer('The catalog is unavailable.'));
  await send();
  await expect(panel.locator('.cllp-tool-row[data-status="failed"]')).toBeVisible();
  await expect(panel.locator('.cllp-tool-error')).toContainText('503');
  await expect(panel.locator('.cllp-message-content').last()).toContainText('catalog is unavailable');
  expect(JSON.parse(requests[1].messages.find((m: any) => m.role === 'tool').content).error).toContain('503');
  await panel.reload();
  await expect(panel.locator('.cllp-tool-error')).toContainText('503');
});

test('a missing active CivitAI tab explains the failure and recovers when the site is active again', async () => {
  const unrelated = await context.newPage();
  await unrelated.goto('about:blank');
  await unrelated.bringToFront();
  replies.push(tool('get_civitai_base_models'), answer('Activate the CivitAI tab and try again.'));
  await send();
  await expect(panel.locator('.cllp-tool-error')).toContainText('Open a CivitAI tab');
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Activate the CivitAI tab');
  expect(catalogUrls).toHaveLength(0);
  expect(JSON.parse(requests[1].messages.find((m: any) => m.role === 'tool').content).error).toContain('Open a CivitAI tab');
  await site.bringToFront();
  replies.push(tool('get_civitai_base_models'), answer('The catalog is reachable again.'));
  await send();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('reachable again');
  await expect(panel.locator('.cllp-tool-row[data-status="completed"]')).toBeVisible();
  await expect(panel.locator('.cllp-tool-row[data-status="failed"]')).toBeVisible();
  expect(catalogUrls).toHaveLength(1);
});

test('the tool limit is visible and repeated lookups are cached within the reply', async () => {
  replies.push(...Array.from({ length: 4 }, () => tool('get_civitai_base_models')), answer('The available bases are Pony and Illustrious.'));
  await send();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Tool limit reached (4 rounds)');
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Pony and Illustrious');
  await expect(panel.locator('.cllp-tool-row[data-status="completed"]')).toHaveCount(4);
  expect(catalogUrls).toHaveLength(1);
  expect(requests).toHaveLength(5);
  expect(requests[4].tools).toBeUndefined();
  await panel.reload();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Tool limit reached (4 rounds)');
});

test('an HTTP-200 provider error leaves an explicit saved failure', async () => {
  replies.push({ error: { code: 'provider_error', message: 'Fixture upstream failure' } });
  await send();
  await expect(panel.locator('.cllp-error-bar')).toContainText('Fixture upstream failure');
  await panel.reload();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Response failed:');
});

test('Stop cancels a tool chain and preserves its history', async () => {
  catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  replies.push(tool('get_civitai_base_models'));
  await send();
  await expect(panel.locator('.cllp-tool-row[data-status="running"]')).toBeVisible();
  await panel.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(panel.locator('.cllp-tool-row[data-status="cancelled"]')).toBeVisible();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Response stopped.');
  expect(requests).toHaveLength(1);
});

test('reopening during a tool call shows its missing result instead of a frozen Running indicator', async () => {
  catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  replies.push(tool('get_civitai_base_models'));
  await send();
  await expect(panel.locator('.cllp-tool-row[data-status="running"]')).toBeVisible();
  await expect.poll(() => worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('cllpConversations');
    return stored.cllpConversations?.[0]?.messages?.at(-1)?.toolActivity?.[0]?.status;
  })).toBe('running');
  await panel.reload();
  await expect(panel.locator('.cllp-tool-row[data-status="interrupted"]')).toBeVisible();
  await expect(panel.locator('.cllp-tool-error')).toContainText('No completion was saved');
  await expect(panel.locator('.cllp-tool-row[data-status="running"]')).toHaveCount(0);
});

test('a proposed prompt waits for Apply and writes the form without a paid generation', async () => {
  replies.push(tool('propose_prompt', { positive: 'A glass whale in a library' }), answer('The prompt is ready.'));
  await send();
  await expect(panel.locator('.cllp-card-apply')).toBeVisible();
  await expect(site.locator('.ProseMirror').first()).toHaveText('');
  await panel.locator('.cllp-card-apply').click();
  await expect(site.locator('.ProseMirror').first()).toContainText('A glass whale in a library');
  expect(await site.evaluate(() => (window as any).generations ?? 0)).toBe(0);
});

/** Fixture of ResourceSelectProvider's public value shape; the extension's MAIN-world bridge is real. */
async function installResourcePicker(options: { incompatible?: boolean; retain?: boolean; connected?: boolean } = {}) {
  const lookups: number[] = [];
  await context.route('https://civitai.red/api/trpc/generation.getGenerationData?*', async (route) => {
    const input = JSON.parse(new URL(route.request().url()).searchParams.get('input')!).json;
    lookups.push(input.id);
    await route.fulfill({ json: { result: { data: { json: { resources: [{
      id: input.id, name: `Version ${input.id}`, model: { id: 12, name: 'Hidden style', type: 'LORA' },
      baseModel: options.incompatible ? 'Illustrious' : 'Pony', canGenerate: true, hasAccess: true,
      strength: 1, minStrength: -1, maxStrength: 2,
    }] } } } } });
  });
  await site.evaluate((options) => {
    localStorage.setItem('fixture-filters', '{"browsingLevel":1,"hiddenModels":[12]}');
    const section = document.createElement('div');
    section.className = 'mantine-InputWrapper-root';
    section.id = 'resources';
    section.innerHTML = '<label>Additional Resources</label><button>Add</button><div id="selected-resources"></div>';
    document.body.appendChild(section);
    section.querySelector('button')!.onclick = () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<input placeholder="Search models"><p>1 models have been hidden due to your settings.</p>';
      document.body.appendChild(dialog);
      const picker = {
        selectSource: 'generation', resources: [{ type: 'LORA', baseModels: ['Pony'] }], filters: {},
        excludedIds: [...section.querySelectorAll('a')].map((a) => Number(new URL(a.href).searchParams.get('modelVersionId'))),
        onSelect: (resource: any) => {
          if (options.retain !== false) {
            const row = document.createElement('div');
            const link = document.createElement('a');
            link.href = `/models/${resource.model.id}?modelVersionId=${resource.id}`;
            link.textContent = resource.model.name;
            const weight = document.createElement('input');
            weight.type = 'number'; weight.value = String(resource.strength);
            row.append(link, weight);
            section.querySelector('#selected-resources')!.appendChild(row);
          }
          dialog.remove();
        },
      };
      if (options.connected !== false) (dialog.querySelector('input') as any).__reactFiber$fixture = { return: { memoizedProps: { value: picker } } };
    };
  }, options);
  return lookups;
}

function resourceProposals() {
  const first = tool('propose_resource', { modelVersionId: 34, name: 'Hidden style', weight: 0.7 });
  const second = tool('propose_resource', { modelVersionId: 35, name: 'Hidden style', weight: 0.9 });
  const call = second.choices[0].delta.tool_calls[0];
  call.index = 1; call.id = 'call-second';
  first.choices[0].delta.tool_calls.push(call);
  return first;
}

test('two hidden LoRAs apply by exact version without extra assistant turns or global filter edits', async () => {
  const lookups = await installResourcePicker();
  replies.push(resourceProposals(), answer('Two resources are ready for approval.'));
  await send();
  await expect(panel.locator('.cllp-card-apply')).toHaveCount(2);
  await expect(panel.locator('.cllp-message-content').last()).toContainText('ready for approval');
  for (let i = 0; i < 2; i++) {
    await panel.locator('.cllp-card-apply').first().click();
    await expect(panel.locator('.cllp-card-apply')).toHaveCount(1 - i);
    expect(requests).toHaveLength(2);
  }
  expect(lookups).toEqual([34, 35]);
  await expect(site.locator('#selected-resources a')).toHaveCount(2);
  await expect(site.locator('#selected-resources input').nth(0)).toHaveValue('0.7');
  await expect(site.locator('#selected-resources input').nth(1)).toHaveValue('0.9');
  expect(await site.evaluate(() => localStorage.getItem('fixture-filters'))).toBe('{"browsingLevel":1,"hiddenModels":[12]}');
  expect(await site.evaluate(() => (window as any).generations ?? 0)).toBe(0);
  replies.push(answer('Both applied versions are recorded.'));
  await send();
  await expect(panel.locator('.cllp-message-content').last()).toContainText('Both applied versions');
  const events = requests[2].messages.filter((m: any) => typeof m.content === 'string' && m.content.startsWith('[TRUSTED EXTENSION ACTION RESULT'));
  expect(events).toHaveLength(2);
  expect(events.map((m: any) => JSON.parse(m.content.split('\n')[1]).action.versionId)).toEqual([34, 35]);
  await panel.reload();
  await expect(panel.locator('.cllp-card-title').filter({ hasText: '✓' })).toHaveCount(2);
});

for (const [label, options, error] of [
  ['incompatible', { incompatible: true }, 'not compatible'],
  ['changed picker UI', { connected: false }, 'UI may have changed'],
  ['discarded selection', { retain: false }, 'did not confirm version 34'],
] as const) {
  test(`a resource with ${label} reports failure instead of claiming Apply succeeded`, async () => {
    await installResourcePicker(options);
    replies.push(tool('propose_resource', { modelVersionId: 34, name: 'Hidden style', weight: 0.7 }), answer('Ready for approval.'), answer('The resource could not be verified.'));
    await send();
    await expect(panel.locator('.cllp-message-content').last()).toContainText('Ready for approval');
    await panel.locator('.cllp-card-apply').click();
    await expect(panel.locator('.cllp-action-card')).toContainText(error);
    await expect(site.locator('#selected-resources a')).toHaveCount(0);
    await expect(panel.locator('.cllp-message-content').last()).toContainText('could not be verified');
    expect(requests).toHaveLength(3);
    const result = requests[2].messages.find((m: any) => typeof m.content === 'string' && m.content.startsWith('[TRUSTED EXTENSION ACTION RESULT'));
    expect(result.content).toContain(error);
  });
}
