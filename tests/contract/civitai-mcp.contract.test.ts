// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  callSiteMcpTool,
  CIVITAI_SITE_MCP_ENDPOINT,
  discoverSiteMcpTools,
  siteMcpRequest,
} from '@/lib/civitai-mcp';

const RUN_LIVE_CONTRACT = process.env.CLLP_RUN_CIVITAI_MCP_CONTRACT === '1';
const PROTOCOL_VERSION = '2025-03-26';

interface LiveToolDescriptor {
  name: string;
  inputSchema?: { type?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function anonymousFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init?.headers).entries()) headers.set(name, value);
  if (headers.has('authorization')) {
    throw new Error('The anonymous CivitAI MCP contract must not send authorization.');
  }
  const url = input instanceof Request ? input.url : String(input);
  if (url !== CIVITAI_SITE_MCP_ENDPOINT) throw new Error(`Unexpected endpoint: ${url}`);
  return fetch(input, init);
}

describe.skipIf(!RUN_LIVE_CONTRACT)('public CivitAI Site MCP contract', () => {
  it('initializes and dynamically exposes the live annotated inventory', async () => {
    const initialized = await siteMcpRequest<{
      protocolVersion?: string;
      serverInfo?: { name?: string };
    }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sieve-and-scribe-contract', version: '1' },
    }, { fetchImpl: anonymousFetch, timeoutMs: 20_000 });
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(initialized.serverInfo?.name).toBe('civitai-mcp-server');

    const listed = await siteMcpRequest<{ tools?: LiveToolDescriptor[] }>(
      'tools/list', {}, { fetchImpl: anonymousFetch, timeoutMs: 20_000 }
    );
    const objectTools = (listed.tools ?? []).filter((tool) => tool.inputSchema?.type === 'object');
    expect(objectTools.length).toBeGreaterThan(0);
    expect(objectTools.some((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(objectTools.some((tool) => tool.annotations?.readOnlyHint !== true)).toBe(true);

    const reads = await discoverSiteMcpTools('read', {
      fetchImpl: anonymousFetch, timeoutMs: 20_000,
    });
    const full = await discoverSiteMcpTools('full', {
      fetchImpl: anonymousFetch, timeoutMs: 20_000,
    });
    expect(reads.map((tool) => tool.definition.function.name).sort()).toEqual(
      objectTools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name).sort()
    );
    expect(full.map((tool) => tool.definition.function.name).sort()).toEqual(
      objectTools.map((tool) => tool.name).sort()
    );
    expect(full.find((tool) => !tool.readOnly)).toBeDefined();
  }, 30_000);

  it('calls one public read and returns bounded normalized content without credentials', async () => {
    const normalizedText = await callSiteMcpTool(
      'search_creators',
      JSON.stringify({ query: 'ZyloO', limit: 1 }),
      { fetchImpl: anonymousFetch, timeoutMs: 20_000 }
    );
    const normalized = JSON.parse(normalizedText) as {
      source?: string; trust?: string; tool?: string; content?: string; error?: string; truncated?: boolean;
    };
    expect(normalized).toMatchObject({
      source: 'CivitAI Site MCP', trust: 'reference_data', tool: 'search_creators', truncated: false,
    });
    expect(normalized.error).toBeUndefined();
    expect(typeof normalized.content).toBe('string');
    expect(normalized.content).not.toMatch(/\.svc\.cluster\.local|localhost|127\.0\.0\.1/i);
    expect(normalizedText.length).toBeLessThanOrEqual(12_500);
  }, 30_000);
});
