import { z } from 'zod';

export const GroqConnectionStateSchema = z.enum([
  'untested',
  'connected',
  'invalid_key',
  'forbidden',
  'rate_limited',
  'network_error',
  'service_error',
]);
export type GroqConnectionState = z.infer<typeof GroqConnectionStateSchema>;

export const GroqModelSchema = z.strictObject({
  id: z.string().min(1),
  contextWindow: z.number().positive().optional(),
});
export type GroqModel = z.infer<typeof GroqModelSchema>;

export const GroqConnectionSchema = z.strictObject({
  state: GroqConnectionStateSchema,
  checkedAt: z.number().nullable(),
  retryAfterSeconds: z.number().nonnegative().optional(),
});
export type GroqConnection = z.infer<typeof GroqConnectionSchema>;

/** Everything other contexts may know about the key. It never contains the key. */
export const GroqStatusSchema = z.strictObject({
  configured: z.boolean(),
  maskedKey: z.string().nullable(),
  connection: GroqConnectionSchema,
  models: z.array(GroqModelSchema),
  selectedModel: z.string().nullable(),
  visionModels: z.array(GroqModelSchema),
  selectedVisionModel: z.string().nullable(),
  /** Tried when no vision model can be discovered. Users can change it as models come and go. */
  visionFallback: z.string(),
  speechModels: z.array(GroqModelSchema),
});
export type GroqStatus = z.infer<typeof GroqStatusSchema>;

export function maskApiKey(apiKey: string): string {
  const dots = '••••••••';
  if (apiKey.length < 16) return dots;
  const prefix = apiKey.startsWith('gsk_') ? 'gsk_' : '';
  return `${prefix}${dots}${apiKey.slice(-4)}`;
}

/** Keys are not parsed further, because Groq's key format could change. */
export function validateApiKeyFormat(apiKey: string): string | null {
  const value = apiKey.trim();
  if (!value) return 'Enter your Groq API key.';
  if (/\s/.test(value)) return 'API keys cannot contain spaces.';
  if (value.length < 20 || value.length > 512) return 'That does not look like a Groq API key.';
  if (/[^\x21-\x7e]/.test(value)) return 'That does not look like a Groq API key.';
  return null;
}

export function describeGroqConnection(status: GroqStatus): string {
  if (!status.configured) return 'No API key saved';
  switch (status.connection.state) {
    case 'untested':
      return 'Key saved, not tested';
    case 'connected':
      return 'Connected to Groq';
    case 'invalid_key':
      return 'Groq rejected this key. It may be invalid or expired.';
    case 'forbidden':
      return 'This key is not allowed to use the Groq API.';
    case 'rate_limited':
      return status.connection.retryAfterSeconds === undefined
        ? 'Rate limited by Groq. Try again shortly.'
        : `Rate limited by Groq. Try again in ${Math.ceil(status.connection.retryAfterSeconds)}s.`;
    case 'network_error':
      return 'Could not reach Groq. Check your connection.';
    case 'service_error':
      return 'Groq is having problems. Try again later.';
  }
}

// Groq's model list has no capability field, so this goes by name. A model that turns out
// not to support tools is skipped at run time, so a wrong guess only costs one request.
const NOT_FOR_TOOLS = /whisper|tts|orpheus|playai|guard|embed|compound|allam|vision/i;
const PREFERRED_FOR_TOOLS = [
  /llama-3\.3-70b-versatile/i,
  /gpt-oss-120b/i,
  /llama-4-maverick/i,
  /llama-4-scout/i,
  /kimi-k2/i,
  /qwen3/i,
  /gpt-oss/i,
  /llama-3\.1-8b-instant/i,
];

export function isToolModelCandidate(id: string): boolean {
  return !NOT_FOR_TOOLS.test(id);
}

/** Best first. Known good families lead, then the largest context window. */
export function rankToolModels(models: GroqModel[]): GroqModel[] {
  const rank = (id: string) => {
    const index = PREFERRED_FOR_TOOLS.findIndex((pattern) => pattern.test(id));
    return index === -1 ? PREFERRED_FOR_TOOLS.length : index;
  };
  return models
    .filter((model) => isToolModelCandidate(model.id))
    .sort(
      (a, b) =>
        rank(a.id) - rank(b.id) ||
        (b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
