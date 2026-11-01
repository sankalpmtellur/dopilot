import { BROWSER_TOOLS, requiresConfirmation } from '@dopilot/browser-tools';
import { ToolResultSchema, toolFailure } from '@dopilot/shared';
import type { ToolResult } from '@dopilot/shared';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Runs a validated tool call. This package only registers tools. Execution lives in
 * the extension, which applies permissions and the safety policy to every call, because
 * MCP clients are as untrusted as the model.
 */
export interface BrowserToolExecutor {
  execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
}

function toCallResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(!result.ok && { isError: true }),
  };
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
      async (args: unknown) => {
        const raw = await executor.execute(tool.name, args as Record<string, unknown>);
        const parsed = ToolResultSchema.safeParse(raw);
        return toCallResult(
          parsed.success
            ? parsed.data
            : toolFailure('invalid_result', 'The browser returned an unexpected result.'),
        );
      },
    );
  }

  return server;
}
