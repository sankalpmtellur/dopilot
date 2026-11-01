import { commandError, ExternalRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
  BrowserCommand,
  CommandResult,
  ExtensionState,
  ExternalResponse,
} from '@dopilot/shared';
import { RateLimiter } from './rate-limit';

/**
 * Must match externally_connectable in the manifest. The browser enforces the
 * manifest and this check is a second, testable layer. Add the production origin
 * to both when one exists.
 */
export const ALLOWED_WEB_ORIGINS: ReadonlySet<string> = new Set(['http://localhost:3000']);

export interface ExternalSender {
  origin?: string | undefined;
  tabId?: number | undefined;
}

export interface ExternalDeps {
  extensionVersion: string;
  getState(senderTabId?: number): Promise<ExtensionState>;
  execute(command: BrowserCommand, requestId: string, senderTabId?: number): Promise<CommandResult>;
  cancel(targetRequestId: string): void;
  openSettings(): Promise<void>;
  startAgent(instruction: string, senderTabId?: number): Promise<string | null>;
  stopAgent(): Promise<void>;
  resetAgent(): Promise<void>;
  transcribe(
    audio: string,
    mimeType: 'audio/webm' | 'audio/ogg' | 'audio/mp4',
  ): Promise<{ text: string | null; error: string | null }>;
  rateLimiter?: RateLimiter;
}

const SEEN_ID_LIMIT = 500;

/** Handles messages from web pages, which are untrusted input. */
export function createExternalHandler(deps: ExternalDeps) {
  const rateLimiter = deps.rateLimiter ?? new RateLimiter(30, 60_000);
  const seenCommandIds = new Set<string>();

  return async function handleExternalMessage(
    message: unknown,
    sender: ExternalSender,
  ): Promise<ExternalResponse> {
    const base = { protocolVersion: PROTOCOL_VERSION } as const;

    if (!sender.origin || !ALLOWED_WEB_ORIGINS.has(sender.origin)) {
      return { ...base, requestId: null, type: 'external.rejected', reason: 'origin_not_allowed' };
    }

    const parsed = ExternalRequestSchema.safeParse(message);
    if (!parsed.success) {
      return { ...base, requestId: null, type: 'external.rejected', reason: 'invalid_message' };
    }

    const request = parsed.data;
    const { requestId } = request;

    switch (request.type) {
      case 'external.ping':
        return {
          ...base,
          requestId,
          type: 'external.pong',
          extensionVersion: deps.extensionVersion,
        };

      case 'external.get_state':
        return {
          ...base,
          requestId,
          type: 'external.state',
          state: await deps.getState(sender.tabId),
        };

      case 'external.cancel':
        deps.cancel(request.targetRequestId);
        return { ...base, requestId, type: 'external.ack' };

      case 'external.open_settings':
        await deps.openSettings();
        return { ...base, requestId, type: 'external.ack' };

      case 'external.agent_start': {
        if (!rateLimiter.tryAcquire()) {
          return {
            ...base,
            requestId,
            type: 'external.agent_started',
            error: 'Too many requests. Wait a moment.',
          };
        }
        return {
          ...base,
          requestId,
          type: 'external.agent_started',
          error: await deps.startAgent(request.instruction, sender.tabId),
        };
      }

      case 'external.transcribe': {
        if (!rateLimiter.tryAcquire()) {
          return {
            ...base,
            requestId,
            type: 'external.transcription',
            text: null,
            error: 'Too many requests. Wait a moment.',
          };
        }
        return {
          ...base,
          requestId,
          type: 'external.transcription',
          ...(await deps.transcribe(request.audio, request.mimeType)),
        };
      }

      case 'external.agent_stop':
        await deps.stopAgent();
        return { ...base, requestId, type: 'external.ack' };

      case 'external.agent_reset':
        await deps.resetAgent();
        return { ...base, requestId, type: 'external.ack' };

      case 'external.command': {
        const respond = (result: CommandResult): ExternalResponse => ({
          ...base,
          requestId,
          type: 'external.command_result',
          result,
        });

        if (seenCommandIds.has(requestId)) {
          return respond(commandError('duplicate_request', 'This request was already handled.'));
        }
        seenCommandIds.add(requestId);
        if (seenCommandIds.size > SEEN_ID_LIMIT) {
          seenCommandIds.delete(seenCommandIds.values().next().value as string);
        }

        if (!rateLimiter.tryAcquire()) {
          return respond(commandError('rate_limited', 'Too many commands. Wait a moment.'));
        }
        return respond(await deps.execute(request.command, requestId, sender.tabId));
      }
    }
  };
}
