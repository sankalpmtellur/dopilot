import { describe, expect, it } from 'vitest';
import {
  chooseVoiceEngine,
  isStopCommand,
  normalizeTranscript,
  rankSpeechModels,
} from './voice.js';

describe('normalizeTranscript', () => {
  it.each([
    ['Dopilot, open YouTube.', 'open YouTube.'],
    ['hey dopilot open a new tab', 'open a new tab'],
    ['Do pilot: scroll down', 'scroll down'],
    ['  scroll   down ', 'scroll down'],
    ['Open Dopilot docs', 'Open Dopilot docs'],
  ])('%s', (input, output) => {
    expect(normalizeTranscript(input)).toBe(output);
  });
});

describe('isStopCommand', () => {
  it('recognizes stopping, however it is said', () => {
    for (const text of ['Stop.', 'stop', 'Dopilot, stop!', 'cancel', 'please stop', 'Stop it.']) {
      expect(isStopCommand(text)).toBe(true);
    }
  });

  it('does not treat other commands as stopping', () => {
    for (const text of ['stop the music on this page', 'bus stop near me', 'cancel my order']) {
      expect(isStopCommand(text)).toBe(false);
    }
  });
});

describe('chooseVoiceEngine', () => {
  const base = {
    choice: 'auto' as const,
    browserAvailable: true,
    browserFailed: false,
    isBrave: false,
    groqAllowed: false,
  };

  it('prefers the free browser engine', () => {
    expect(chooseVoiceEngine({ ...base, groqAllowed: true })).toBe('browser');
  });

  it('uses Groq on Brave, where the browser engine has no service, only if allowed', () => {
    expect(chooseVoiceEngine({ ...base, isBrave: true, groqAllowed: true })).toBe('groq');
    expect(chooseVoiceEngine({ ...base, isBrave: true })).toBe('browser');
  });

  it('falls back after the browser engine fails, only if allowed', () => {
    expect(chooseVoiceEngine({ ...base, browserFailed: true, groqAllowed: true })).toBe('groq');
    expect(chooseVoiceEngine({ ...base, browserFailed: true })).toBe('none');
  });

  it('never sends audio to Groq without agreement, even when asked to use it', () => {
    expect(chooseVoiceEngine({ ...base, choice: 'groq' })).toBe('none');
  });

  it('respects an explicit browser choice', () => {
    expect(chooseVoiceEngine({ ...base, choice: 'browser', groqAllowed: true })).toBe('browser');
    expect(chooseVoiceEngine({ ...base, choice: 'browser', browserAvailable: false })).toBe('none');
  });
});

describe('rankSpeechModels', () => {
  it('finds speech models and prefers the faster, cheaper one', () => {
    const ranked = rankSpeechModels([
      { id: 'whisper-large-v3' },
      { id: 'llama-3.3-70b-versatile' },
      { id: 'whisper-large-v3-turbo' },
    ]);
    expect(ranked.map((model) => model.id)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3']);
  });
});
