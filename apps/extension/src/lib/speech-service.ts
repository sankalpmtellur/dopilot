import { ModelError } from '@dopilot/agent-core';
import {
  DEFAULT_SPEECH_MODEL,
  MAX_NO_SPEECH_PROBABILITY,
  MIN_AUDIO_BASE64_CHARS,
  rankSpeechModels,
} from '@dopilot/shared';
import type { AUDIO_TYPES } from '@dopilot/shared';
import Groq, { toFile } from 'groq-sdk';
import { loadApiKey, loadGroqStatus } from './api-key-store';
import { toModelError } from './groq-client';
import { loadPreferences } from './preferences';
import { RateLimiter } from '@/messaging/rate-limit';

export interface TranscriptionOutcome {
  text: string | null;
  error: string | null;
}

const failure = (error: string): TranscriptionOutcome => ({ text: null, error });

const limiter = new RateLimiter(10, 60_000);
const REQUEST_TIMEOUT_MS = 30_000;
/** Gets names right that speech models otherwise mangle, without steering anything else. */
const VOCABULARY_HINT = 'Dopilot. Open a new tab. Go to YouTube, Wikipedia, GitHub. Switch tabs.';

interface VerboseTranscription {
  text?: string;
  segments?: { no_speech_prob?: number; text?: string }[];
}

/**
 * Whisper writes something even for silence, often "Thank you." Acting on that would be a
 * command nobody gave, so only segments it believes contain speech are kept.
 */
export function spokenText(result: VerboseTranscription): string {
  if (!result.segments?.length) return result.text?.trim() ?? '';
  return result.segments
    .filter((segment) => (segment.no_speech_prob ?? 0) <= MAX_NO_SPEECH_PROBABILITY)
    .map((segment) => segment.text ?? '')
    .join('')
    .trim();
}

function decodeAudio(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Turns one recording into text, using the user's own key. Refused unless the user has
 * agreed in extension settings, so a website cannot turn this on. The audio is only
 * forwarded to Groq, and is not kept.
 */
export async function transcribeAudio(
  audio: string,
  mimeType: (typeof AUDIO_TYPES)[number],
  fetchImpl?: typeof fetch,
): Promise<TranscriptionOutcome> {
  if (!(await loadPreferences()).speechFallback) {
    return failure('Sending voice to Groq is turned off. Turn it on in Dopilot’s settings.');
  }
  const apiKey = await loadApiKey();
  if (!apiKey) return failure('Add your Groq API key in Dopilot’s settings first.');
  if (!limiter.tryAcquire()) return failure('Too many voice requests. Wait a moment.');

  const bytes = decodeAudio(audio);
  if (!bytes?.length) return failure('That recording could not be read.');
  // Too short to hold words, and it would still cost a request and return invented text.
  if (audio.length < MIN_AUDIO_BASE64_CHARS) return failure('No speech was recognized.');

  const groq = new Groq({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    ...(fetchImpl && { fetch: fetchImpl }),
  });

  const status = await loadGroqStatus();
  const candidates = [
    ...new Set([...rankSpeechModels(status.speechModels).map((m) => m.id), DEFAULT_SPEECH_MODEL]),
  ];
  const extension = mimeType.split('/')[1];

  for (const model of candidates) {
    try {
      const file = await toFile(bytes, `speech.${extension}`, { type: mimeType });
      // Bounded here too, because the SDK's timeout ends once response headers arrive.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      const result = await groq.audio.transcriptions
        .create(
          {
            file,
            model,
            temperature: 0,
            response_format: 'verbose_json',
            prompt: VOCABULARY_HINT,
          },
          { signal: abort.signal },
        )
        .finally(() => clearTimeout(timer));
      const text = spokenText(result as VerboseTranscription);
      return text ? { text, error: null } : failure('No speech was recognized.');
    } catch (error) {
      const modelError = error instanceof ModelError ? error : toModelError(error);
      if (modelError.kind === 'model_unavailable') continue;
      if (modelError.kind === 'cancelled') return failure('Groq took too long to transcribe that.');
      if (modelError.kind === 'rate_limited') {
        return failure(`Groq’s free-tier limit for voice was reached. ${modelError.message}`);
      }
      return failure(modelError.message);
    }
  }
  return failure('No speech model is available right now.');
}
