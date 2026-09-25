import { describe, expect, it, vi } from 'vitest';
import { callSiteMcpTool, discoverSiteMcpTools, siteMcpRequest } from '@/lib/civitai-mcp';

function response(body: unknown, contentType = 'application/json') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

const liveTools = [
  {
    name: 'search_images',
    description: 'Search images',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'toggle_favorite',
    title: 'Toggle favorite',
    inputSchema: { type: 'object', properties: { imageId: { type: 'integer' } } },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'delete_post',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
    annotations: { destructiveHint: true },
  },
];

describe('CivitAI Site MCP client', () => {
  it('advertises every annotated read with the official name and schema', async () => {
    const fetchImpl = vi.fn(async () => response({ jsonrpc: '2.0', id: 1, result: { tools: liveTools } }));
    const tools = await discoverSiteMcpTools('read', { fetchImpl: fetchImpl as any });

    expect(tools.map((tool) => tool.definition.function.name)).toEqual(['search_images']);
    expect(tools[0].definition.function.parameters).toEqual(liveTools[0].inputSchema);
    expect(tools[0].readOnly).toBe(true);
  });

  it('advertises all server tools in full mode and treats missing readOnlyHint as write', async () => {
    const fetchImpl = vi.fn(async () => response({ jsonrpc: '2.0', id: 1, result: { tools: liveTools } }));
    const tools = await discoverSiteMcpTools('full', { fetchImpl: fetchImpl as any });

    expect(tools.map((tool) => tool.definition.function.name)).toEqual([
      'search_images', 'toggle_favorite', 'delete_post',
    ]);
    expect(tools[1]).toMatchObject({ readOnly: false, destructive: false, title: 'Toggle favorite' });
    expect(tools[2]).toMatchObject({ readOnly: false, destructive: true });
  });

  it('does no network work in off mode', async () => {
    const fetchImpl = vi.fn();
    await expect(discoverSiteMcpTools('off', { fetchImpl: fetchImpl as any })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses Streamable HTTP event-stream responses', async () => {
    const fetchImpl = vi.fn(async () => response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      'text/event-stream'
    ));
    await expect(siteMcpRequest('test', {}, { fetchImpl: fetchImpl as any })).resolves.toEqual({ ok: true });
  });

  it('passes official arguments unchanged, authenticates only the fixed endpoint, and bounds output', async () => {
    let sent: any;
    let authorization: string | null = null;
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get('authorization');
      return response({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: 'Creator https://users.svc.cluster.local/profile safe text' }] },
      });
    });
    const result = JSON.parse(await callSiteMcpTool(
      'search_creators',
      JSON.stringify({ query: 'rain', serverSupportedOption: true }),
      { fetchImpl: fetchImpl as any, token: 'civitai-test-token' }
    ));

    expect(sent.params).toEqual({
      name: 'search_creators',
      arguments: { query: 'rain', serverSupportedOption: true },
    });
    expect(authorization).toBe('Bearer civitai-test-token');
    expect(result).toMatchObject({ source: 'CivitAI Site MCP', trust: 'reference_data' });
    expect(JSON.stringify(result)).not.toContain('svc.cluster.local');
  });

  it('turns MCP tool errors into bounded error envelopes', async () => {
    const fetchImpl = vi.fn(async () => response({
      jsonrpc: '2.0', id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'invalid arguments' }] },
    }));
    const result = JSON.parse(await callSiteMcpTool('get_image', '{"ids":[1]}', { fetchImpl: fetchImpl as any }));
    expect(result.error).toBe('invalid arguments');
  });
});
