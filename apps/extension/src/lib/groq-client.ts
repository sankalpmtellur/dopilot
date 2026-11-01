import { ModelError } from '@dopilot/agent-core';
import type { ModelClient, ModelMessage, ModelResponse } from '@dopilot/agent-core';
import Groq from 'groq-sdk';

type GroqMessage = Groq.Chat.ChatCompletionMessageParam;

const REQUEST_TIMEOUT_MS = 30_000;
/** Enough for a tool call or a short answer, and small enough to protect the quota. */
const MAX_COMPLETION_TOKENS = 1000;

function toGroqMessage(message: ModelMessage): GroqMessage {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

  switch (message.role) {
    case 'system':
      return { role: 'system', content: text };
    case 'tool':
      return { role: 'tool', content: text, tool_call_id: message.toolCallId ?? '' };
    case 'assistant':
      return {
        role: 'assistant',
        content: text,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        }),
      };
    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text' as const, text: part.text }
                  : { type: 'image_url' as const, image_url: { url: part.dataUrl } },
              ),
      };
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    // Left for tool validation to reject; malformed output must not crash the loop.
    return raw;
  }
}

function readRetryAfter(error: InstanceType<typeof Groq.APIError>): number | undefined {
  const raw = (error.headers as Headers | undefined)?.get?.('retry-after');
  const seconds = Number(raw);
  return raw && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function describeWait(seconds: number | undefined): string {
  if (seconds === undefined) return 'Try again shortly.';
  if (seconds < 90) return `Try again in ${Math.ceil(seconds)}s.`;
  if (seconds < 5400) return `Try again in ${Math.ceil(seconds / 60)} minutes.`;
  return `Try again in about ${Math.ceil(seconds / 3600)} hours.`;
}

/**
 * Turns SDK errors into states the loop can act on. Groq's own error text is only
 * used to classify, never shown, so nothing unexpected reaches the UI or the logs.
 */
export function toModelError(error: unknown): ModelError {
  if (error instanceof Groq.APIUserAbortError) return new ModelError('cancelled', 'Cancelled.');
  if (error instanceof Groq.APIConnectionTimeoutError) {
    return new ModelError('timeout', 'Groq took too long to respond.');
  }
  if (error instanceof Groq.APIConnectionError) {
    return new ModelError('network', 'Could not reach Groq. Check your connection.');
  }
  if (error instanceof Groq.AuthenticationError) {
    return new ModelError(
      'invalid_key',
      'Groq rejected your API key. It may be invalid or expired.',
    );
  }
  if (error instanceof Groq.PermissionDeniedError) {
    return new ModelError('forbidden', 'Your API key is not allowed to use this.');
  }
  if (error instanceof Groq.RateLimitError) {
    const seconds = readRetryAfter(error);
    return new ModelError(
      'rate_limited',
      `Rate limited by Groq. ${describeWait(seconds)}`,
      seconds,
    );
  }
  if (error instanceof Groq.NotFoundError) {
    return new ModelError('model_unavailable', 'That model is not available.');
  }
  if (error instanceof Groq.APIError) {
    const body = error.error as
      { code?: string; message?: string; error?: { code?: string; message?: string } } | undefined;
    const code = body?.error?.code ?? body?.code ?? '';
    const message = body?.error?.message ?? body?.message ?? error.message ?? '';

    if (error.status === 413) {
      return new ModelError('request_too_large', 'This page was too large for the selected model.');
    }
    if (code === 'tool_use_failed') {
      return new ModelError('bad_tool_call', 'The AI produced an invalid action, retrying.');
    }
    if (
      code === 'model_not_found' ||
      code === 'model_decommissioned' ||
      /does not support|not support.*tool|decommissioned/i.test(message)
    ) {
      return new ModelError('model_unavailable', 'That model cannot be used for this.');
    }
    if (error.status && error.status < 500) {
      return new ModelError('server', 'Groq could not process that request.');
    }
    return new ModelError('server', 'Groq is having problems.');
  }
  return new ModelError('server', 'The AI request failed.');
}

/**
 * Sends requests straight from the extension to Groq, so the key never touches
 * our backend. `dangerouslyAllowBrowser` is required for that design: the key is
 * the user's own and stays in the extension, never in a webpage. Retries are
 * handled by the agent loop, which can see the whole task, so the SDK makes none.
 */
export function createGroqModelClient(apiKey: string, fetchImpl?: typeof fetch): ModelClient {
  const groq = new Groq({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    ...(fetchImpl && { fetch: fetchImpl }),
  });

  return {
    async complete({ model, messages, tools, signal }): Promise<ModelResponse> {
      try {
        const completion = await groq.chat.completions.create(
          {
            model,
            messages: messages.map(toGroqMessage),
            temperature: 0.1,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
            ...(tools.length > 0 && {
              tool_choice: 'auto' as const,
              tools: tools.map((tool) => ({ type: 'function' as const, function: tool })),
            }),
          },
          { signal },
        );

        const reply = completion.choices[0]?.message;
        return {
          text: reply?.content ?? null,
          toolCalls: (reply?.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          })),
        };
      } catch (error) {
        throw toModelError(error);
      }
    },
  };
}
