import { BROWSER_TOOLS, requiresConfirmation } from '@dopilot/browser-tools';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Runs a validated tool call. The implementation must enforce permissions and
 * user confirmation, because MCP clients are as untrusted as the model.
 */
export interface BrowserToolExecutor {
  execute(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function createBrowserMcpServer(
  executor: BrowserToolExecutor,
  info: { name: string; version: string },
): McpServer {
  const server = new McpServer(info);

  for (const tool of BROWSER_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.risk === 'read',
          destructiveHint: requiresConfirmation(tool),
          openWorldHint: true,
        },
      },
      (args: unknown) => executor.execute(tool.name, args as Record<string, unknown>),
    );
  }

  return server;
}
