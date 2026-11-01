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
import { addAuthorizedSite, rememberGrantedSites } from './site-access';

type RequestBody = PanelRequest extends infer R
  ? R extends PanelRequest
    ? Omit<R, 'protocolVersion'>
    : never
  : never;

const REQUEST_TIMEOUT_MS = 15_000;
/** These wait on Groq, which the worker bounds by itself. */
const SLOW_TIMEOUT_MS = 50_000;

async function send(body: RequestBody): Promise<PanelResponse> {
  const limit =
    body.type === 'panel.transcribe' || body.type === 'panel.test_groq'
      ? SLOW_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A worker that is restarting may never answer, and no button should wait on it forever.
    const raw: unknown = await Promise.race([
      chrome.runtime.sendMessage({ protocolVersion: PROTOCOL_VERSION, ...body }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The service worker did not respond')), limit);
      }),
    ]);
    return PanelResponseSchema.parse(raw);
  } finally {
    clearTimeout(timer);
  }
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
  // Stop has to work. A first attempt can fail while the worker wakes up.
  await send({ type: 'panel.stop_agent' }).catch(() => send({ type: 'panel.stop_agent' }));
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
    if (granted) await addAuthorizedSite(approval.origin);
  } else if (approved && approval.kind === 'screenshot_access') {
    await rememberGrantedSites();
    granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  } else if (approved && approval.kind === 'tab_details') {
    granted = await chrome.permissions.request({ permissions: ['tabs'] });
  }
  await resolveApproval(approval.id, granted);
}

/** Only extension pages can ask for this. Screenshots are never sent to the website. */
export async function getScreenshotPreview(id: string): Promise<string | null> {
  const response = await send({ type: 'panel.get_screenshot', id });
  return response.type === 'panel.screenshot' ? response.dataUrl : unexpected();
}

export async function transcribe(
  audio: string,
  mimeType: 'audio/webm' | 'audio/ogg' | 'audio/mp4',
): Promise<{ text: string | null; error: string | null }> {
  const response = await send({ type: 'panel.transcribe', audio, mimeType });
  return response.type === 'panel.transcription'
    ? { text: response.text, error: response.error }
    : unexpected();
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
