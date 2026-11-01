import { PanelRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
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
    case 'panel.stop_agent':
      // Nothing can run yet. The agent loop will abort its ExecutionGuard here.
      return { ...base, type: 'panel.ack' };
  }
}
