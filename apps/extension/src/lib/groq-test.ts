import type { GroqConnection, GroqModel } from '@dopilot/shared';
import Groq from 'groq-sdk';

// Groq's list also includes speech and moderation models, which cannot run text
// commands. There is no capability field, so this filters by name.
const NON_TEXT_MODEL = /whisper|tts|orpheus|playai|guard|embed/i;

export interface GroqTestOutcome {
  connection: GroqConnection;
  /** Null when the test could not fetch a list. */
  models: GroqModel[] | null;
}

function readRetryAfter(error: InstanceType<typeof Groq.APIError>): number | undefined {
  const headers = error.headers as Headers | Record<string, string> | undefined;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers as Record<string, string> | undefined)?.['retry-after'];
  const seconds = Number(raw);
  return raw && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Checks a key by listing models, which is authenticated but uses no tokens.
 * Only reached from an explicit Test action. Error text from the API is dropped
 * and replaced with fixed states, so nothing in it can reach the UI or the logs.
 */
export async function testGroqKey(
  apiKey: string,
  now: number = Date.now(),
  fetchImpl?: typeof fetch,
): Promise<GroqTestOutcome> {
  const groq = new Groq({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: 10_000,
    ...(fetchImpl && { fetch: fetchImpl }),
  });

  const failed = (state: GroqConnection['state'], retryAfterSeconds?: number): GroqTestOutcome => ({
    connection: {
      state,
      checkedAt: now,
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    },
    models: null,
  });

  try {
    const { data } = await groq.models.list();
    const models = data
      .filter((model) => (model as { active?: boolean }).active !== false)
      .filter((model) => !NON_TEXT_MODEL.test(model.id))
      .map((model) => ({ id: model.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { connection: { state: 'connected', checkedAt: now }, models };
  } catch (error) {
    if (error instanceof Groq.AuthenticationError) return failed('invalid_key');
    if (error instanceof Groq.PermissionDeniedError) return failed('forbidden');
    if (error instanceof Groq.RateLimitError) return failed('rate_limited', readRetryAfter(error));
    if (error instanceof Groq.APIConnectionError) return failed('network_error');
    return failed('service_error');
  }
}
