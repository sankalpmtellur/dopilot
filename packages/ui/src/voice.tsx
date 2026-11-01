import {
  chooseVoiceEngine,
  isStopCommand,
  MAX_RECORDING_MS,
  normalizeTranscript,
} from '@dopilot/shared';
import type { VoiceEngine, VoiceEngineChoice } from '@dopilot/shared';
import { Loader, Mic, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { IconButton } from './button.js';

export type VoiceStatus = 'idle' | 'starting' | 'listening' | 'processing';

export type VoiceErrorKind =
  | 'mic_blocked'
  | 'no_mic'
  | 'no_speech'
  | 'needs_consent'
  | 'unsupported'
  | 'browser_failed'
  | 'failed';

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
}

type AudioType = 'audio/webm' | 'audio/ogg' | 'audio/mp4';

export type TranscribeAudio = (
  audio: string,
  mimeType: AudioType,
) => Promise<{ text: string | null; error: string | null }>;

export interface VoiceInputOptions {
  choice: VoiceEngineChoice;
  /** Whether the user has agreed to audio being sent to Groq. */
  groqAllowed: boolean;
  transcribe: TranscribeAudio;
  onTranscript: (text: string) => void;
  /** A spoken "stop", handled here so it works without the AI. */
  onStopCommand: () => void;
  /** Runs when listening starts, so spoken output can get out of the way. */
  onListeningStart?: () => void;
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionClass(): (new () => RecognitionLike) | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

function isBraveBrowser(): boolean {
  return Boolean((navigator as Navigator & { brave?: unknown }).brave);
}

function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function recordingType(): { full: string; base: AudioType } {
  const options: [string, AudioType][] = [
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['audio/ogg;codecs=opus', 'audio/ogg'],
    ['audio/mp4', 'audio/mp4'],
  ];
  for (const [full, base] of options) {
    if (MediaRecorder.isTypeSupported?.(full)) return { full, base };
  }
  return { full: '', base: 'audio/webm' };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });
}

/** A permission prompt can sit unanswered, and side panels may never show one at all. */
const MIC_START_TIMEOUT_MS = 15_000;
const TRANSCRIBE_TIMEOUT_MS = 45_000;
/** A browser speech session should end by itself. This covers the one that never does. */
const RECOGNITION_LIMIT_MS = MAX_RECORDING_MS + 5000;

const MIC_ERRORS: Record<string, VoiceError> = {
  NotAllowedError: {
    kind: 'mic_blocked',
    message: 'Microphone access is blocked. Allow it to use voice.',
  },
  SecurityError: {
    kind: 'mic_blocked',
    message: 'Microphone access is blocked. Allow it to use voice.',
  },
  NotFoundError: { kind: 'no_mic', message: 'No microphone was found.' },
  NotReadableError: {
    kind: 'failed',
    message: 'The microphone is being used by another app. Close it and try again.',
  },
  AbortError: { kind: 'failed', message: 'The microphone could not be started. Try again.' },
};

/**
 * Push-to-talk. Nothing listens until the user acts, and the microphone is released as
 * soon as they finish or cancel. Recordings exist only in memory until they are sent.
 */
export function useVoiceInput(options: VoiceInputOptions) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<VoiceError | null>(null);
  const [engine, setEngine] = useState<VoiceEngine>('none');

  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const browserFailed = useRef(false);
  const session = useRef<{ finish: () => void; cancel: () => void } | null>(null);
  const cancelled = useRef(false);

  const deliver = useCallback((raw: string) => {
    setStatus('idle');
    if (cancelled.current) return;
    if (isStopCommand(raw)) {
      setTranscript('');
      latest.current.onStopCommand();
      return;
    }
    const text = normalizeTranscript(raw);
    if (!text) {
      setError({ kind: 'no_speech', message: 'I didn’t catch that. Try again.' });
      return;
    }
    setTranscript('');
    latest.current.onTranscript(text);
  }, []);

  const startBrowser = useCallback(
    (Recognition: new () => RecognitionLike) => {
      const recognition = new Recognition();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;

      let finalText = '';
      let interimText = '';
      let failed = false;
      const limit = setTimeout(() => {
        // onend may never come, so this cannot wait for it.
        failed = true;
        session.current = null;
        recognition.abort();
        setStatus('idle');
        setError({ kind: 'failed', message: 'Listening stopped responding. Try again.' });
      }, RECOGNITION_LIMIT_MS);

      recognition.onresult = (event) => {
        interimText = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const piece = result?.[0]?.transcript ?? '';
          if (result?.isFinal) finalText += piece;
          else interimText += piece;
        }
        setTranscript(`${finalText}${interimText}`);
      };

      recognition.onerror = ({ error: code }) => {
        if (code === 'aborted') return;
        clearTimeout(limit);
        failed = true;
        session.current = null;
        setStatus('idle');
        if (code === 'no-speech') {
          setError({ kind: 'no_speech', message: 'I didn’t hear anything. Try again.' });
        } else if (code === 'not-allowed') {
          setError(MIC_ERRORS.NotAllowedError as VoiceError);
        } else if (code === 'audio-capture') {
          setError(MIC_ERRORS.NotFoundError as VoiceError);
        } else {
          // Typical in Brave, which has the API but no speech service behind it.
          browserFailed.current = true;
          setError({
            kind: 'browser_failed',
            message: latest.current.groqAllowed
              ? 'Your browser’s speech service isn’t available. Press the microphone again to use Groq instead.'
              : 'Your browser’s speech service isn’t available. To use voice, allow sending voice to Groq in Dopilot’s settings.',
          });
        }
      };

      recognition.onend = () => {
        clearTimeout(limit);
        session.current = null;
        if (failed) return;
        deliver(`${finalText}${interimText}`);
      };

      session.current = {
        finish: () => recognition.stop(),
        cancel: () => recognition.abort(),
      };
      setStatus('listening');
      try {
        recognition.start();
      } catch {
        clearTimeout(limit);
        session.current = null;
        setStatus('idle');
        setError({ kind: 'failed', message: 'Voice input could not be started. Try again.' });
      }
    },
    [deliver],
  );

  const startRecorder = useCallback(async () => {
    // Not "listening" until it really is: microphones can take a moment to open.
    setStatus('starting');
    let finishedEarly = false;
    session.current = {
      finish: () => {
        finishedEarly = true;
      },
      cancel: () => undefined,
    };

    let stream: MediaStream;
    let gaveUp = false;
    try {
      const opening = navigator.mediaDevices.getUserMedia({ audio: true });
      // If it opens after all, it must still be closed, or the microphone stays on.
      void opening.then(
        (late) => {
          if (gaveUp) for (const track of late.getTracks()) track.stop();
        },
        () => undefined,
      );
      stream = await new Promise<MediaStream>((resolve, reject) => {
        const timer = setTimeout(() => {
          gaveUp = true;
          reject(new DOMException('Timed out', 'NotAllowedError'));
        }, MIC_START_TIMEOUT_MS);
        void opening.finally(() => clearTimeout(timer)).then(resolve, reject);
      });
    } catch (caught) {
      session.current = null;
      setStatus('idle');
      const name = (caught as { name?: string } | null)?.name ?? '';
      setError(
        MIC_ERRORS[name] ?? { kind: 'failed', message: 'The microphone could not be started.' },
      );
      return;
    }
    if (cancelled.current || finishedEarly) {
      // Released before the microphone was ready, so nothing was recorded and nothing is sent.
      for (const track of stream.getTracks()) track.stop();
      session.current = null;
      setStatus('idle');
      if (finishedEarly && !cancelled.current) {
        setError({
          kind: 'no_speech',
          message: 'Hold the button a little longer while you speak.',
        });
      }
      return;
    }

    const release = () => {
      for (const track of stream.getTracks()) track.stop();
    };
    const { full, base } = recordingType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(full && { mimeType: full }),
        audioBitsPerSecond: 24_000,
      });
    } catch {
      release();
      session.current = null;
      setStatus('idle');
      setError({ kind: 'failed', message: 'This browser could not record audio.' });
      return;
    }
    const chunks: Blob[] = [];
    const limit = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, MAX_RECORDING_MS);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      clearTimeout(limit);
      release();
      session.current = null;
      recorder.onstop = null;
      setStatus('idle');
      setError({ kind: 'failed', message: 'Recording stopped unexpectedly. Try again.' });
    };
    recorder.onstop = () => {
      clearTimeout(limit);
      release();
      session.current = null;
      if (cancelled.current) {
        setStatus('idle');
        return;
      }
      const recording = new Blob(chunks, { type: base });
      chunks.length = 0;
      if (recording.size === 0) {
        setStatus('idle');
        setError({ kind: 'no_speech', message: 'I didn’t hear anything. Try again.' });
        return;
      }
      setStatus('processing');
      void (async () => {
        try {
          const audio = await blobToBase64(recording);
          const { text, error: problem } = await Promise.race([
            latest.current.transcribe(audio, base),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Timed out')), TRANSCRIBE_TIMEOUT_MS);
            }),
          ]);
          if (cancelled.current) {
            setStatus('idle');
            return;
          }
          if (problem || !text) {
            setStatus('idle');
            setError({ kind: 'failed', message: problem ?? 'No speech was recognized.' });
            return;
          }
          setTranscript(text);
          deliver(text);
        } catch {
          setStatus('idle');
          if (!cancelled.current) {
            setError({
              kind: 'failed',
              message: 'That recording could not be transcribed. Try again, or type instead.',
            });
          }
        }
      })();
    };

    session.current = {
      finish: () => {
        if (recorder.state === 'recording') recorder.stop();
      },
      cancel: () => {
        clearTimeout(limit);
        if (recorder.state === 'recording') recorder.stop();
        else release();
      },
    };
    try {
      recorder.start();
    } catch {
      clearTimeout(limit);
      release();
      session.current = null;
      setStatus('idle');
      setError({ kind: 'failed', message: 'This browser could not record audio.' });
      return;
    }
    setStatus('listening');
  }, [deliver]);

  const start = useCallback(() => {
    if (session.current || status !== 'idle') return;
    cancelled.current = false;
    setError(null);
    setTranscript('');

    const Recognition = recognitionClass();
    const chosen = chooseVoiceEngine({
      choice: latest.current.choice,
      browserAvailable: Boolean(Recognition),
      browserFailed: browserFailed.current,
      isBrave: isBraveBrowser(),
      groqAllowed: latest.current.groqAllowed && canRecord(),
    });
    setEngine(chosen);

    if (chosen === 'none') {
      setError(
        latest.current.groqAllowed
          ? { kind: 'unsupported', message: 'Voice input isn’t supported in this browser.' }
          : {
              kind: 'needs_consent',
              message:
                'Your browser has no speech service here. To use voice, allow sending voice to Groq in Dopilot’s settings. You can still type.',
            },
      );
      return;
    }

    latest.current.onListeningStart?.();
    if (chosen === 'browser' && Recognition) startBrowser(Recognition);
    else void startRecorder();
  }, [startBrowser, startRecorder, status]);

  const finish = useCallback(() => session.current?.finish(), []);

  const cancel = useCallback(() => {
    cancelled.current = true;
    session.current?.cancel();
    session.current = null;
    setStatus('idle');
    setTranscript('');
    setError(null);
  }, []);

  // Leaving the page must never leave the microphone running.
  useEffect(
    () => () => {
      cancelled.current = true;
      session.current?.cancel();
    },
    [],
  );

  return { status, transcript, error, engine, start, finish, cancel };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;

const HOLD_MS = 350;

/** Hold to talk and release to send, or tap once to start and again to finish. */
export function VoiceButton({ voice }: { voice: VoiceInput }) {
  const press = useRef<{ at: number; started: boolean } | null>(null);
  const handledByPointer = useRef(false);
  const { status, start, finish } = voice;

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    handledByPointer.current = true;
    press.current = { at: Date.now(), started: status === 'idle' };
    if (status === 'idle') start();
  };

  const onPointerUp = () => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    // Releasing a long press ends it. A quick tap leaves it listening until the next tap.
    const held = Date.now() - current.at >= HOLD_MS;
    if (!current.started || held) finish();
  };

  const onClick = () => {
    // A press already acted through the pointer. A click alone comes from the keyboard or
    // assistive technology.
    if (handledByPointer.current) {
      handledByPointer.current = false;
      return;
    }
    if (status === 'idle') start();
    else if (status === 'listening' || status === 'starting') finish();
  };

  const listening = status === 'listening' || status === 'starting';
  const label = listening ? 'Finish speaking' : 'Speak a command';

  return (
    <span className="relative inline-flex">
      {listening && (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-lg bg-accent-soft"
        />
      )}
      <IconButton
        label={label}
        aria-pressed={listening}
        disabled={status === 'processing'}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={onClick}
        className={`relative touch-none ${listening ? 'bg-accent-soft text-accent' : ''}`}
      >
        {status === 'processing' ? (
          <Loader aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Mic aria-hidden="true" className="size-4" />
        )}
      </IconButton>
    </span>
  );
}

export interface VoiceStatusLineProps {
  voice: VoiceInput;
  /** Offered with a blocked microphone, or when voice needs turning on. */
  onOpenSettings?: () => void;
}

/** What the microphone is doing, including where audio is going. */
export function VoiceStatusLine({ voice, onOpenSettings }: VoiceStatusLineProps) {
  const { status, transcript, error, engine, cancel } = voice;

  // A press of Escape cancels, as it does elsewhere.
  useEffect(() => {
    if (status === 'idle') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, cancel]);

  if (status === 'idle' && !error) return null;

  if (error) {
    const fixable = ['mic_blocked', 'needs_consent', 'browser_failed'].includes(error.kind);
    return (
      <div role="alert" className="animate-fade flex flex-wrap items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 basis-48 text-danger">{error.message}</span>
        {fixable && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="underline underline-offset-2 hover:text-ink"
          >
            Open settings
          </button>
        )}
      </div>
    );
  }

  const destination =
    engine === 'groq'
      ? 'Your voice will be sent to Groq to be transcribed.'
      : 'Your browser’s speech service is listening.';

  return (
    <div className="animate-fade flex items-center gap-2" data-testid="voice-status">
      <div className="min-w-0 flex-1">
        <p role="status" className="text-[13px] font-medium">
          {status === 'starting'
            ? 'Getting the microphone ready…'
            : status === 'listening'
              ? 'Listening…'
              : 'Transcribing…'}
        </p>
        <p className="text-[13px] break-words text-muted" data-testid="voice-transcript">
          {transcript || destination}
        </p>
      </div>
      <IconButton label="Cancel voice input" onClick={cancel} className="size-7">
        <X aria-hidden="true" className="size-3.5" />
      </IconButton>
    </div>
  );
}
