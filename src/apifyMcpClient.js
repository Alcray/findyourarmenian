import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

export async function inspectApifyMcpTools() {
  if (!config.apifyMcpUrl || !config.apifyToken) {
    return {
      available: false,
      tools: [],
      error: 'Apify MCP URL or token is not configured.',
    };
  }

  let client;
  try {
    client = await connectApifyMcp();
    const result = await client.listTools({}, { timeout: 20000 });
    return {
      available: true,
      tools: (result.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
      })),
    };
  } catch (error) {
    return {
      available: false,
      tools: [],
      error: error.message,
    };
  } finally {
    await client?.close?.();
  }
}

export async function callApifyMcpTool(name, args = {}) {
  let client;
  try {
    client = await connectApifyMcp();
    return await client.callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      { timeout: config.apifyRequestTimeoutMs },
    );
  } finally {
    await client?.close?.();
  }
}

async function connectApifyMcp() {
  const client = new Client({
    name: 'find-your-armenian',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.apifyMcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${config.apifyToken}`,
      },
    },
  });
  await client.connect(transport);
  return client;
}
