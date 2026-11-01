import { commandError, ExternalResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type {
  BrowserCommand,
  CommandResult,
  ExtensionState,
  ExternalRequest,
  ExternalResponse,
} from '@dopilot/shared';

/** Fixed by the public key in the extension's manifest. */
const DEFAULT_EXTENSION_ID = 'doennedjpkdlajeeplfioihckoffjeld';

export function getExtensionId(): string {
  return process.env.NEXT_PUBLIC_DOPILOT_EXTENSION_ID || DEFAULT_EXTENSION_ID;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Closing a tab waits for the user to answer in the extension's confirmation window. */
const CONFIRMATION_TIMEOUT_MS = 60_000;

export type BridgeFailure = 'extension_unavailable' | 'timeout' | 'cancelled' | 'invalid_response';

export type BridgeOutcome =
  { ok: true; response: ExternalResponse } | { ok: false; failure: BridgeFailure };

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

type RequestBody = ExternalRequest extends infer R
  ? R extends ExternalRequest
    ? Omit<R, 'protocolVersion' | 'requestId'>
    : never
  : never;

interface SendOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

async function send(
  extensionId: string,
  body: RequestBody,
  { timeoutMs = DEFAULT_TIMEOUT_MS, signal }: SendOptions = {},
): Promise<BridgeOutcome> {
  const runtime = getRuntime();
  if (!runtime) return { ok: false, failure: 'extension_unavailable' };
  if (signal?.aborted) return { ok: false, failure: 'cancelled' };

  const requestId = crypto.randomUUID();
  const notifyCancel = () => {
    if (body.type === 'external.command') {
      void send(extensionId, { type: 'external.cancel', targetRequestId: requestId });
    }
  };

  return new Promise<BridgeOutcome>((resolve) => {
    const finish = (outcome: BridgeOutcome) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      notifyCancel();
      finish({ ok: false, failure: 'cancelled' });
    };
    const timer = setTimeout(() => {
      notifyCancel();
      finish({ ok: false, failure: 'timeout' });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    runtime
      .sendMessage(extensionId, { protocolVersion: PROTOCOL_VERSION, requestId, ...body })
      .then((raw) => {
        const parsed = ExternalResponseSchema.safeParse(raw);
        const matches =
          parsed.success &&
          (parsed.data.requestId === requestId || parsed.data.type === 'external.rejected');
        finish(
          matches
            ? { ok: true, response: parsed.data }
            : { ok: false, failure: 'invalid_response' },
        );
      })
      // Rejects when the extension is missing, disabled, or being reloaded.
      .catch(() => finish({ ok: false, failure: 'extension_unavailable' }));
  });
}

export async function fetchExtensionState(extensionId: string): Promise<ExtensionState | null> {
  const outcome = await send(extensionId, { type: 'external.get_state' });
  return outcome.ok && outcome.response.type === 'external.state' ? outcome.response.state : null;
}

export async function openExtensionSettings(extensionId: string): Promise<boolean> {
  const outcome = await send(extensionId, { type: 'external.open_settings' });
  return outcome.ok && outcome.response.type === 'external.ack';
}

/** Resolves to why the task could not start, or null. */
export async function startAgentTask(
  extensionId: string,
  instruction: string,
): Promise<string | null> {
  const outcome = await send(extensionId, { type: 'external.agent_start', instruction });
  if (!outcome.ok) {
    return outcome.failure === 'extension_unavailable'
      ? 'The Dopilot extension isn’t connected, so nothing was done.'
      : 'The extension didn’t respond, so the task may not have started.';
  }
  return outcome.response.type === 'external.agent_started'
    ? outcome.response.error
    : 'The extension refused that request.';
}

export async function stopAgentTask(extensionId: string): Promise<boolean> {
  const outcome = await send(extensionId, { type: 'external.agent_stop' });
  return outcome.ok && outcome.response.type === 'external.ack';
}

export async function resetAgent(extensionId: string): Promise<void> {
  await send(extensionId, { type: 'external.agent_reset' });
}

const FAILURE_RESULTS: Record<BridgeFailure, CommandResult> = {
  extension_unavailable: commandError(
    'extension_unavailable',
    'The Dopilot extension isn’t connected, so nothing was done.',
  ),
  timeout: commandError('timeout', 'The extension didn’t respond in time.'),
  cancelled: commandError('cancelled', 'Stopped.'),
  invalid_response: commandError(
    'execution_failed',
    'The extension sent an unexpected response. Check that it is up to date.',
  ),
};

export async function sendBrowserCommand(
  extensionId: string,
  command: BrowserCommand,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const outcome = await send(
    extensionId,
    { type: 'external.command', command },
    {
      signal,
      timeoutMs: command.action === 'tab.close' ? CONFIRMATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    },
  );
  if (!outcome.ok) return FAILURE_RESULTS[outcome.failure];
  if (outcome.response.type === 'external.command_result') return outcome.response.result;
  return FAILURE_RESULTS.invalid_response;
}
