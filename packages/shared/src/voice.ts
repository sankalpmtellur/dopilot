import { z } from 'zod';
import type { GroqModel } from './groq.js';

export const DEFAULT_SPEECH_MODEL = 'whisper-large-v3-turbo';

export function rankSpeechModels(models: GroqModel[]): GroqModel[] {
  const rank = (id: string) => (/turbo/i.test(id) ? 0 : 1);
  return models
    .filter((model) => /whisper|transcribe/i.test(model.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export const VoiceEngineChoiceSchema = z.enum(['auto', 'browser', 'groq']);
export type VoiceEngineChoice = z.infer<typeof VoiceEngineChoiceSchema>;

export const MAX_RECORDING_MS = 20_000;
/**
 * Little more than an empty container. Kept low, because a quick spoken "stop" must never be
 * thrown away, and silence is already caught by `MAX_NO_SPEECH_PROBABILITY`.
 */
export const MIN_AUDIO_BASE64_CHARS = 300;
/** Above this a segment is noise. Whisper still returns text for it, often "Thank you." */
export const MAX_NO_SPEECH_PROBABILITY = 0.6;
/** About 20 seconds of speech at the recording's low bitrate, with room to spare. */
export const MAX_AUDIO_BASE64_CHARS = 500_000;
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'] as const;

export const AudioPayloadSchema = {
  audio: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
  mimeType: z.enum(AUDIO_TYPES),
};

/** Non-secret settings the website may read. Only extension pages can change them. */
export const PreferencesSchema = z.strictObject({
  vision: z.boolean(),
  /** Off until the user agrees to audio being sent to Groq. */
  speechFallback: z.boolean(),
  voiceEngine: VoiceEngineChoiceSchema,
  /** Whether another model may stand in when the selected one is unavailable. */
  modelFallback: z.boolean().default(true),
  /** Spending limits for one task. Optional, so older saved settings stay valid. */
  maxTaskRequests: z.number().int().min(1).max(30).default(30),
  maxTaskTokens: z.number().int().min(1000).max(500_000).default(60_000),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  vision: true,
  speechFallback: false,
  voiceEngine: 'auto',
  modelFallback: true,
  maxTaskRequests: 30,
  maxTaskTokens: 60_000,
};

export type VoiceEngine = 'browser' | 'groq' | 'none';

/**
 * Picks how to turn speech into text. Brave ships the browser speech API but does not
 * connect it to a speech service, so there it is only used if nothing else is allowed.
 */
export function chooseVoiceEngine(options: {
  choice: VoiceEngineChoice;
  browserAvailable: boolean;
  browserFailed: boolean;
  isBrave: boolean;
  groqAllowed: boolean;
}): VoiceEngine {
  const { choice, browserAvailable, browserFailed, isBrave, groqAllowed } = options;
  if (choice === 'browser') return browserAvailable ? 'browser' : 'none';
  if (choice === 'groq') return groqAllowed ? 'groq' : 'none';
  const browserUsable = browserAvailable && !browserFailed;
  if (groqAllowed && (isBrave || !browserUsable)) return 'groq';
  return browserUsable ? 'browser' : 'none';
}

const WAKE_PREFIX = /^\s*(?:(?:hey|ok|okay|hi)[\s,]+)?(?:do ?pilot|the pilot)\b[\s,.:!-]*/i;

/** Tidies a transcript. A spoken "Dopilot," is an address, not part of the command. */
export function normalizeTranscript(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(WAKE_PREFIX, '').trim();
  // Speech services sometimes return only punctuation for noise, which is not a command.
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

/** Stopping must work without the AI, so it is recognized before anything else. */
export function isStopCommand(text: string): boolean {
  return /^(?:please\s+)?(?:stop|cancel|stop it|stop now|stop that|cancel that|halt)[.!]*$/i.test(
    normalizeTranscript(text),
  );
}
