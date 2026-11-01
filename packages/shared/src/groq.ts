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

export const ModelIssueSchema = z.strictObject({
  reason: z.enum(['unavailable', 'no_tools']),
  at: z.number(),
});
export type ModelIssue = z.infer<typeof ModelIssueSchema>;

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
  /** Models Groq has refused recently, so they are not tried on every task. */
  modelIssues: z.record(z.string(), ModelIssueSchema).optional(),
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
// not to support tools is recorded at run time, so a wrong guess only costs one request.
const NOT_FOR_TOOLS = /whisper|tts|orpheus|playai|guard|embed|compound|allam|vision/i;
const SPEECH_ONLY = /whisper|transcribe/i;
const PREFERRED_FOR_TOOLS = [
  /llama-3\.3-70b-versatile/i,
  /gpt-oss-120b/i,
  /qwen3/i,
  /minimax/i,
  /muse-spark/i,
  /kimi-k2/i,
  /gpt-oss/i,
  /llama-3\.1-8b-instant/i,
];

/** Used when no list can be fetched. A real request then decides whether it still exists. */
export const DEFAULT_TOOL_MODEL = 'llama-3.3-70b-versatile';
/** Model lists change rarely, so one fetch a day is plenty. */
export const MODEL_LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Retired models stay retired, but a brief outage should not rule one out for long. */
export const MODEL_ISSUE_TTL_MS = 6 * 60 * 60 * 1000;

export function isToolModelCandidate(id: string): boolean {
  return !NOT_FOR_TOOLS.test(id);
}

export function isSpeechModel(id: string): boolean {
  return SPEECH_ONLY.test(id);
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

export type ToolModelChoice = { id: string; notice?: string } | { refusal: string };

/**
 * Picks the model for a task. The user's choice wins while it can do the job. If it cannot,
 * another is only used when the user allows that, and they are always told. A model that
 * cannot use tools is never chosen, whatever else is available.
 */
export function chooseToolModel(options: {
  status: Pick<GroqStatus, 'selectedModel' | 'models' | 'modelIssues'>;
  tried: string[];
  allowFallback: boolean;
  now: number;
}): ToolModelChoice {
  const { status, tried, allowFallback, now } = options;
  const hasIssue = (id: string) => {
    const issue = status.modelIssues?.[id];
    return issue !== undefined && now - issue.at < MODEL_ISSUE_TTL_MS;
  };
  const usable = (id: string) => isToolModelCandidate(id) && !tried.includes(id) && !hasIssue(id);
  const selected = status.selectedModel;

  if (selected && usable(selected)) return { id: selected };

  if (selected && !allowFallback) {
    return {
      refusal: `Your selected model, ${selected}, can’t run this right now. Choose another in Dopilot’s settings, or allow fallback models there.`,
    };
  }

  const next =
    rankToolModels(status.models).find((model) => usable(model.id))?.id ??
    (usable(DEFAULT_TOOL_MODEL) && status.models.length === 0 ? DEFAULT_TOOL_MODEL : null);
  if (!next) {
    return {
      refusal: tried.length
        ? 'None of the available Groq models could run this. Choose another in settings.'
        : 'No Groq model is available. Test your key in settings.',
    };
  }
  return selected
    ? { id: next, notice: `${selected} isn’t available, so ${next} is being used instead.` }
    : { id: next };
}
