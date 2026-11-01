import { ExternalResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { ExternalRequest, ExternalResponse } from '@dopilot/shared';

export type ExtensionConnection =
  { state: 'not_configured' | 'not_detected' } | { state: 'connected'; version: string };

interface RuntimeWithMessaging {
  sendMessage(extensionId: string, message: unknown): Promise<unknown>;
}

/**
 * Pages cannot call privileged extension APIs. Browsers only expose this one
 * messaging function, and only to origins in the manifest's externally_connectable.
 * The extension validates every message again on its side.
 */
function getRuntime(): RuntimeWithMessaging | undefined {
  const { chrome } = globalThis as { chrome?: { runtime?: Partial<RuntimeWithMessaging> } };
  const runtime = chrome?.runtime;
  return runtime?.sendMessage ? (runtime as RuntimeWithMessaging) : undefined;
}

async function send(extensionId: string, request: ExternalRequest): Promise<ExternalResponse> {
  const runtime = getRuntime();
  if (!runtime) throw new Error('Extension messaging is unavailable');
  return ExternalResponseSchema.parse(await runtime.sendMessage(extensionId, request));
}

export async function connectToExtension(
  extensionId: string | undefined,
): Promise<ExtensionConnection> {
  if (!extensionId) return { state: 'not_configured' };
  try {
    const response = await send(extensionId, {
      protocolVersion: PROTOCOL_VERSION,
      type: 'external.ping',
    });
    return response.type === 'external.pong'
      ? { state: 'connected', version: response.extensionVersion }
      : { state: 'not_detected' };
  } catch {
    return { state: 'not_detected' };
  }
}
