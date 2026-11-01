import { PanelResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
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

export async function getConfirmationPrompt(id: string): Promise<string | null> {
  const response = await send({ type: 'panel.get_confirmation', id });
  return response.type === 'panel.confirmation' ? response.prompt : unexpected();
}

export async function decideConfirmation(id: string, approved: boolean): Promise<void> {
  await send({ type: 'panel.decide_confirmation', id, approved });
}
