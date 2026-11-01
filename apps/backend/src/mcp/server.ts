import { createBrowserMcpServer } from '@dopilot/mcp-tools';

/**
 * Not attached to any transport yet. Browser actions can only run inside the
 * extension, so until a secure extension bridge exists every call reports that.
 */
export function createBackendMcpServer() {
  return createBrowserMcpServer(
    {
      execute: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'The Dopilot extension is not connected.' }],
      }),
    },
    { name: 'dopilot', version: '0.1.0' },
  );
}
