import type { AgentRunView } from '@dopilot/shared';
import { isAgentActive } from '@dopilot/shared';
import { Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from './button.js';
import type { ConsoleMessage } from './use-command-console.js';

const STORAGE_KEY = 'dopilot.spoken';
const MAX_SPOKEN_CHARS = 160;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function canSpeak(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

function firstSentence(text: string): string {
  const sentence = /^.*?[.!?](?:\s|$)/s.exec(text)?.[0] ?? text;
  return sentence.trim().slice(0, MAX_SPOKEN_CHARS);
}

function tidyAction(label: string): string {
  return label.replace(/https?:\/\/(?:www\.)?/gi, '').replace(/\/(?=\s|$|\.)/g, '');
}

/**
 * What to say for the current state of a task, if anything, and a key to say it once.
 * Only the first action is announced, not every step. An answer built from page content
 * is never read out, because it could be anything a page contains.
 */
export function spokenForRun(run: AgentRunView): { key: string; text: string } | null {
  if (!isAgentActive(run.status)) {
    const key = `${run.id}:end`;
    switch (run.status) {
      case 'completed':
        return {
          key,
          text: run.readPageContent
            ? 'Done. The answer is on your screen.'
            : firstSentence(run.summary ?? 'Done.'),
        };
      case 'failed':
        return { key, text: 'That didn’t work. The details are on your screen.' };
      default:
        return { key, text: 'Stopped.' };
    }
  }
  if (run.approval)
    return { key: `${run.id}:approval:${run.approval.id}`, text: 'I need your approval.' };

  const firstAction = run.timeline.find((entry) => entry.kind === 'act');
  return firstAction
    ? {
        key: `${run.id}:start`,
        text: `${tidyAction(firstAction.label)}.`.slice(0, MAX_SPOKEN_CHARS),
      }
    : null;
}

export interface SpokenResponsesOptions {
  run: AgentRunView | null;
  messages: ConsoleMessage[];
}

/** Optional spoken replies. Off until the user turns them on, and easy to interrupt. */
export function useSpokenResponses({ run, messages }: SpokenResponsesOptions) {
  const [enabled, setEnabledState] = useState(readEnabled);
  const spoken = useRef(new Set<string>());
  const available = canSpeak();

  const interrupt = useCallback(() => {
    if (canSpeak()) speechSynthesis.cancel();
  }, []);

  const say = useCallback((text: string) => {
    if (!canSpeak() || !text) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      if (!next) interrupt();
      try {
        if (next) localStorage.setItem(STORAGE_KEY, 'true');
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // The choice still applies until the page reloads.
      }
    },
    [interrupt],
  );

  // Things from before spoken replies were turned on stay quiet.
  useEffect(() => {
    if (enabled) return;
    if (run) {
      const event = spokenForRun(run);
      if (event) spoken.current.add(event.key);
    }
    for (const message of messages) spoken.current.add(message.id);
  }, [enabled, run, messages]);

  useEffect(() => {
    if (!enabled || !run) return;
    const event = spokenForRun(run);
    if (!event || spoken.current.has(event.key)) return;
    spoken.current.add(event.key);
    say(event.text);
  }, [enabled, run, say]);

  // Results of exact commands are fixed text from Dopilot, so they are safe to read.
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || spoken.current.has(last.id)) return;
    if (last.role !== 'dopilot' || last.status === 'pending' || last.id.startsWith('run-')) return;
    if (!enabled) return;
    spoken.current.add(last.id);
    if (last.text.length <= MAX_SPOKEN_CHARS) say(last.text);
  }, [enabled, messages, say]);

  useEffect(() => interrupt, [interrupt]);

  return { enabled, setEnabled, interrupt, available };
}

export function SpokenToggle({
  enabled,
  onChange,
  available,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  available: boolean;
}) {
  if (!available) return null;
  return (
    <IconButton
      label={enabled ? 'Mute spoken replies' : 'Turn on spoken replies'}
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
    >
      {enabled ? (
        <Volume2 aria-hidden="true" className="size-4" />
      ) : (
        <VolumeX aria-hidden="true" className="size-4" />
      )}
    </IconButton>
  );
}
