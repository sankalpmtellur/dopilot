import { createBrowserMcpServer } from '@dopilot/mcp-tools';
import type { BrowserToolExecutor } from '@dopilot/mcp-tools';

export function createBackendMcpServer(executor: BrowserToolExecutor) {
  return createBrowserMcpServer(executor, { name: 'dopilot', version: '0.1.0' });
}
