import { ExternalRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { ExternalResponse } from '@dopilot/shared';

/**
 * Must match externally_connectable in the manifest. The browser enforces the
 * manifest and this check is a second, testable layer. Add the production origin
 * to both when one exists.
 */
export const ALLOWED_WEB_ORIGINS: ReadonlySet<string> = new Set(['http://localhost:3000']);

/** Handles messages from web pages, which are untrusted input. */
export function handleExternalMessage(
  message: unknown,
  senderOrigin: string | undefined,
  extensionVersion: string,
): ExternalResponse {
  if (!senderOrigin || !ALLOWED_WEB_ORIGINS.has(senderOrigin)) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'external.rejected',
      reason: 'origin_not_allowed',
    };
  }

  const parsed = ExternalRequestSchema.safeParse(message);
  if (!parsed.success) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'external.rejected',
      reason: 'invalid_message',
    };
  }

  return { protocolVersion: PROTOCOL_VERSION, type: 'external.pong', extensionVersion };
}
