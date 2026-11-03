import { ModelError } from '@dopilot/agent-core';
import type { ModelClient, ModelMessage, ModelResponse } from '@dopilot/agent-core';
import type { ToolCall } from '@dopilot/shared';
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
            function: { name: call.name, arguments: historyArguments(call.arguments) },
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

/** Models that have refused the setting, so they are not sent it again this session. */
const noParallelSetting = new Set<string>();

/**
 * Llama models sometimes write a call as text in their own format. It is still only a
 * request: it goes through the same validation and safety checks as any other call.
 */
export function salvageToolCall(text: string | null | undefined): ToolCall | null {
  if (!text) return null;
  const trimmed = text.trim();
  const named = /<function=([a-zA-Z_]+)[\s>]*/.exec(trimmed);
  if (named?.[1]) {
    const args = firstJsonObject(trimmed.slice(named.index + named[0].length));
    return args ? { id: `salvaged_${crypto.randomUUID()}`, name: named[1], arguments: args } : null;
  }
  // Some models write the whole call as JSON instead of using the interface.
  if (!trimmed.startsWith('{')) return null;
  const whole = firstJsonObject(trimmed) as { name?: unknown; arguments?: unknown } | null;
  if (typeof whole?.name !== 'string' || typeof whole.arguments !== 'object' || !whole.arguments) {
    return null;
  }
  return {
    id: `salvaged_${crypto.randomUUID()}`,
    name: whole.name,
    arguments: whole.arguments,
  };
}

/** The first complete object, counting braces, because arguments can themselves be nested. */
function firstJsonObject(text: string): object | null {
  if (!text.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(0, index + 1));
          return typeof parsed === 'object' && parsed !== null ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** History must hold valid arguments, or Groq rejects every later request in the task. */
function historyArguments(args: unknown): string {
  return JSON.stringify(typeof args === 'object' && args !== null ? args : {});
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
  if (raw && Number.isFinite(seconds) && seconds >= 0) return seconds;
  // Groq also states the wait in the message, as "try again in 1m7.2s".
  const stated = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(
    errorBody(error).message,
  );
  if (!stated || (!stated[1] && !stated[2] && !stated[3])) return undefined;
  return Number(stated[1] ?? 0) * 3600 + Number(stated[2] ?? 0) * 60 + Number(stated[3] ?? 0);
}

function errorBody(error: InstanceType<typeof Groq.APIError>) {
  const body = error.error as
    | {
        code?: string;
        message?: string;
        failed_generation?: string;
        error?: { code?: string; message?: string; failed_generation?: string };
      }
    | undefined;
  return {
    code: body?.error?.code ?? body?.code ?? '',
    message: body?.error?.message ?? body?.message ?? error.message ?? '',
    failedGeneration: body?.error?.failed_generation ?? body?.failed_generation,
  };
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
    const { code, message } = errorBody(error);

    if (error.status === 413 || code === 'context_length_exceeded') {
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
    if (/image|media|multimodal/i.test(message)) {
      return new ModelError('image_rejected', 'Groq could not accept that image.');
    }
    if (error.status && error.status < 500) {
      return new ModelError('server', 'Groq could not process that request.');
    }
    return new ModelError('server', 'Groq is having problems right now. This is not your setup.');
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

  async function request(
    { model, messages, tools, signal }: Parameters<ModelClient['complete']>[0],
    allowSetting: boolean,
  ): Promise<ModelResponse> {
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
            // Several calls at once are planned blind, which is how two tabs get opened.
            ...(allowSetting && { parallel_tool_calls: false }),
          }),
        },
        { signal },
      );

      const reply = completion.choices[0]?.message;
      const toolCalls = (reply?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      }));
      const leaked = toolCalls.length === 0 ? salvageToolCall(reply?.content) : null;
      return {
        text: leaked ? null : (reply?.content ?? null),
        toolCalls: leaked ? [leaked] : toolCalls,
        ...(completion.usage && {
          usage: {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
          },
        }),
      };
    } catch (error) {
      if (error instanceof Groq.APIError) {
        const { code, message, failedGeneration } = errorBody(error);
        if (allowSetting && /parallel_tool_calls/i.test(message)) {
          noParallelSetting.add(model);
          return request({ model, messages, tools, signal }, false);
        }
        if (code === 'tool_use_failed') {
          const salvaged = salvageToolCall(failedGeneration);
          if (salvaged) return { text: null, toolCalls: [salvaged] };
        }
      }
      throw toModelError(error);
    }
  }

  return {
    complete: (options) => request(options, !noParallelSetting.has(options.model)),
  };
}
