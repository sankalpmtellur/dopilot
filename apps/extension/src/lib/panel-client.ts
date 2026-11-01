import { PanelResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
  AgentApproval,
  BrowserCommand,
  CommandResult,
  ExtensionState,
  GroqStatus,
  PanelRequest,
  PanelResponse,
} from '@dopilot/shared';

type RequestBody = PanelRequest extends infer R
  ? R extends PanelRequest
    ? Omit<R, 'protocolVersion'>
    : never
  : never;

async function send(body: RequestBody): Promise<PanelResponse> {
  const raw: unknown = await chrome.runtime.sendMessage({
    protocolVersion: PROTOCOL_VERSION,
    ...body,
  });
  return PanelResponseSchema.parse(raw);
}

function unexpected(): never {
  throw new Error('Unexpected response from the service worker');
}

export async function getState(): Promise<ExtensionState> {
  const response = await send({ type: 'panel.get_state' });
  return response.type === 'panel.state' ? response.state : unexpected();
}

export async function executeCommand(
  command: BrowserCommand,
  confirmed: boolean,
): Promise<CommandResult> {
  const response = await send({ type: 'panel.execute', command, confirmed });
  return response.type === 'panel.command_result' ? response.result : unexpected();
}

export async function testGroqConnection(): Promise<GroqStatus> {
  const response = await send({ type: 'panel.test_groq' });
  return response.type === 'panel.groq_status' ? response.groq : unexpected();
}

export async function stopAgent(): Promise<void> {
  await send({ type: 'panel.stop_agent' });
}

export async function startAgent(instruction: string): Promise<string | null> {
  const response = await send({ type: 'panel.start_agent', instruction });
  return response.type === 'panel.agent_started' ? response.error : unexpected();
}

export async function resetConversation(): Promise<void> {
  await send({ type: 'panel.reset_conversation' });
}

export async function resolveApproval(id: string, approved: boolean): Promise<void> {
  await send({ type: 'panel.resolve_approval', id, approved });
}

export async function getApproval(id: string): Promise<AgentApproval | null> {
  const response = await send({ type: 'panel.get_approval', id });
  return response.type === 'panel.approval' ? response.approval : unexpected();
}

/**
 * Answers an approval from a click. Permissions must be requested inside the click
 * itself, because browsers refuse them anywhere else, so this cannot be left to the worker.
 */
export async function answerApproval(approval: AgentApproval, approved: boolean): Promise<void> {
  let granted = approved;
  if (approved && approval.kind === 'site_access' && approval.origin) {
    granted = await chrome.permissions.request({ origins: [`${approval.origin}/*`] });
  } else if (approved && approval.kind === 'tab_details') {
    granted = await chrome.permissions.request({ permissions: ['tabs'] });
  }
  await resolveApproval(approval.id, granted);
}

export async function getMcpStatus(): Promise<{ enabled: boolean; connected: boolean }> {
  const response = await send({ type: 'panel.mcp_status' });
  return response.type === 'panel.mcp_status'
    ? { enabled: response.enabled, connected: response.connected }
    : unexpected();
}

export async function configureMcp(token: string | null): Promise<void> {
  await send({ type: 'panel.mcp_configure', token });
}

export async function getConfirmationPrompt(id: string): Promise<string | null> {
  const response = await send({ type: 'panel.get_confirmation', id });
  return response.type === 'panel.confirmation' ? response.prompt : unexpected();
}

export async function decideConfirmation(id: string, approved: boolean): Promise<void> {
  await send({ type: 'panel.decide_confirmation', id, approved });
}
