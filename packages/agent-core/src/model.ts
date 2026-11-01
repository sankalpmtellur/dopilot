import type { ToolCall } from '@dopilot/shared';

export type ModelContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  /** Set on `tool` messages: the call this result answers. */
  toolCallId?: string;
  /** Set on `assistant` messages that requested tools. */
  toolCalls?: ToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  signal: AbortSignal;
}

export interface ModelResponse {
  text: string | null;
  toolCalls: ToolCall[];
}

export type ModelErrorKind =
  | 'invalid_key'
  | 'forbidden'
  | 'rate_limited'
  /** The model is gone or cannot use tools, so another may work. */
  | 'model_unavailable'
  /** The model produced a malformed tool call, which often succeeds on a retry. */
  | 'bad_tool_call'
  | 'timeout'
  | 'network'
  | 'server'
  | 'request_too_large'
  | 'cancelled';

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** The agent loop depends on this interface, never on a provider's SDK. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
