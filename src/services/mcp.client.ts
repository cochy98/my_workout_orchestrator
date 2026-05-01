import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

let mcpClient: Client | null = null;
let discoveredTools: McpTool[] = [];

export async function initMcpClient(): Promise<void> {
  const serverPath = process.env.MCP_SERVER_PATH;
  if (!serverPath) {
    throw new Error('MCP_SERVER_PATH is not set in environment.');
  }

  const resolvedPath = path.resolve(__dirname, '../../', serverPath);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolvedPath],
  });

  mcpClient = new Client(
    { name: 'myworkout-orchestrator', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);

  const result = await mcpClient.listTools();
  discoveredTools = result.tools as McpTool[];

  console.log(`[MCP] Discovered ${discoveredTools.length} tools:`, discoveredTools.map(t => t.name));
}

export function getDiscoveredTools(): McpTool[] {
  return discoveredTools;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!mcpClient) {
    throw new Error('MCP client is not initialised.');
  }

  console.log(`[MCP] Calling tool: ${name}`, args);
  const result = await mcpClient.callTool({ name, arguments: args });
  console.log(`[MCP] Tool result for ${name}:`, result.content);

  return result.content;
}
