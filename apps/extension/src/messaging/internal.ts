import { PanelRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
  AgentApproval,
  BrowserCommand,
  CommandResult,
  ExtensionState,
  GroqStatus,
  PanelResponse,
} from '@dopilot/shared';
import { isExtensionPage } from './sender';

export interface InternalDeps {
  extensionId: string;
  getState(): Promise<ExtensionState>;
  execute(command: BrowserCommand, confirmed: boolean): Promise<CommandResult>;
  testGroq(): Promise<GroqStatus>;
  getConfirmationPrompt(id: string): string | null;
  decideConfirmation(id: string, approved: boolean): void;
  startAgent(instruction: string): Promise<string | null>;
  stopAgent(): Promise<void>;
  resetAgent(): Promise<void>;
  resolveApproval(id: string, approved: boolean): Promise<void>;
  getApproval(id: string): Promise<AgentApproval | null>;
  mcpStatus(): { enabled: boolean; connected: boolean };
  mcpConfigure(token: string | null): Promise<void>;
  transcribe(
    audio: string,
    mimeType: 'audio/webm' | 'audio/ogg' | 'audio/mp4',
  ): Promise<{ text: string | null; error: string | null }>;
  getScreenshot(id: string): string | null;
}

/** Handles messages from extension pages. Returns null for anything else. */
export async function handleInternalMessage(
  message: unknown,
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'origin'>,
  deps: InternalDeps,
): Promise<PanelResponse | null> {
  if (!isExtensionPage(sender, deps.extensionId)) return null;

  const parsed = PanelRequestSchema.safeParse(message);
  if (!parsed.success) return null;

  const base = { protocolVersion: PROTOCOL_VERSION } as const;
  const request = parsed.data;

  switch (request.type) {
    case 'panel.get_state':
      return { ...base, type: 'panel.state', state: await deps.getState() };
    case 'panel.execute':
      return {
        ...base,
        type: 'panel.command_result',
        result: await deps.execute(request.command, request.confirmed),
      };
    case 'panel.test_groq':
      return { ...base, type: 'panel.groq_status', groq: await deps.testGroq() };
    case 'panel.get_confirmation':
      return {
        ...base,
        type: 'panel.confirmation',
        prompt: deps.getConfirmationPrompt(request.id),
      };
    case 'panel.decide_confirmation':
      deps.decideConfirmation(request.id, request.approved);
      return { ...base, type: 'panel.ack' };
    case 'panel.start_agent':
      return {
        ...base,
        type: 'panel.agent_started',
        error: await deps.startAgent(request.instruction),
      };
    case 'panel.stop_agent':
      await deps.stopAgent();
      return { ...base, type: 'panel.ack' };
    case 'panel.reset_conversation':
      await deps.resetAgent();
      return { ...base, type: 'panel.ack' };
    case 'panel.resolve_approval':
      await deps.resolveApproval(request.id, request.approved);
      return { ...base, type: 'panel.ack' };
    case 'panel.get_approval':
      return { ...base, type: 'panel.approval', approval: await deps.getApproval(request.id) };
    case 'panel.transcribe':
      return {
        ...base,
        type: 'panel.transcription',
        ...(await deps.transcribe(request.audio, request.mimeType)),
      };
    case 'panel.get_screenshot':
      return { ...base, type: 'panel.screenshot', dataUrl: deps.getScreenshot(request.id) };
    case 'panel.mcp_status':
      return { ...base, type: 'panel.mcp_status', ...deps.mcpStatus() };
    case 'panel.mcp_configure':
      await deps.mcpConfigure(request.token);
      return { ...base, type: 'panel.mcp_status', ...deps.mcpStatus() };
  }
}
