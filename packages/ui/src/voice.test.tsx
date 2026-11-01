// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInput, VoiceButton, VoiceStatusLine } from './voice.js';
import type { TranscribeAudio, VoiceInputOptions } from './voice.js';

class FakeRecognition {
  static last: FakeRecognition;
  lang = '';
  continuous = true;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  hear(text: string, isFinal: boolean) {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = () => true;
  state = 'inactive';
  options: unknown;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options: unknown) {
    this.options = options;
    FakeRecorder.last = this;
  }
  start = () => {
    this.state = 'recording';
  };
  stop = () => {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    this.onstop?.();
  };
}

let track: { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;

function Harness(props: Partial<VoiceInputOptions>) {
  const voice = useVoiceInput({
    choice: 'auto',
    groqAllowed: false,
    transcribe: vi.fn(),
    onTranscript: vi.fn(),
    onStopCommand: vi.fn(),
    ...props,
  });
  return (
    <div>
      <VoiceStatusLine voice={voice} onOpenSettings={() => undefined} />
      <VoiceButton voice={voice} />
    </div>
  );
}

const mic = () => screen.getByRole('button', { name: /Speak a command|Finish speaking/ });

beforeEach(() => {
  track = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as { brave?: unknown }).brave;
});

describe('nothing happens without the user', () => {
  it('does not touch the microphone until pressed', () => {
    render(<Harness groqAllowed />);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voice-status')).toBeNull();
  });

  it('is push-to-talk, so one utterance only', async () => {
    render(<Harness />);
    await userEvent.click(mic());
    expect(FakeRecognition.last.continuous).toBe(false);
  });
});

describe('browser speech recognition', () => {
  it('shows a live transcript, then submits the final text', async () => {
    const onTranscript = vi.fn();
    render(<Harness onTranscript={onTranscript} />);
    await userEvent.click(mic());
    expect(screen.getByText('Listening…')).toBeTruthy();

    act(() => FakeRecognition.last.hear('open you', false));
    expect(screen.getByTestId('voice-transcript').textContent).toBe('open you');
    expect(onTranscript).not.toHaveBeenCalled();

    act(() => FakeRecognition.last.hear('Dopilot, open YouTube.', true));
    act(() => FakeRecognition.last.stop());
    expect(onTranscript).toHaveBeenCalledWith('open YouTube.');
  });

  it('a second press finishes', async () => {
    render(<Harness />);
    await userEvent.click(mic());
    await userEvent.click(mic());
    expect(FakeRecognition.last.stop).toHaveBeenCalled();
  });

  it('holding and releasing finishes too', async () => {
    const user = userEvent.setup();
    let time = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    render(<Harness />);
    await user.pointer({ keys: '[MouseLeft>]', target: mic() });
    expect(FakeRecognition.last.start).toHaveBeenCalled();
    expect(FakeRecognition.last.stop).not.toHaveBeenCalled();
    time = 2000;
    await user.pointer({ keys: '[/MouseLeft]', target: mic() });
    expect(FakeRecognition.last.stop).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a quick tap keeps listening, until the next tap', async () => {
    render(<Harness />);
    await userEvent.click(mic());
    expect(FakeRecognition.last.stop).not.toHaveBeenCalled();
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  it('works from the keyboard', async () => {
    render(<Harness />);
    mic().focus();
    await userEvent.keyboard('{Enter}');
    expect(FakeRecognition.last.start).toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(FakeRecognition.last.stop).toHaveBeenCalled();
  });

  it('a spoken stop stops, without going to the agent', async () => {
    const onStopCommand = vi.fn();
    const onTranscript = vi.fn();
    render(<Harness onStopCommand={onStopCommand} onTranscript={onTranscript} />);
    await userEvent.click(mic());
    act(() => FakeRecognition.last.hear('Stop.', true));
    act(() => FakeRecognition.last.stop());
    expect(onStopCommand).toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ['not-allowed', /blocked/],
    ['audio-capture', /No microphone/],
    ['no-speech', /didn’t hear/],
    ['network', /speech service isn’t available/],
  ])('explains the %s error', async (code, message) => {
    const onTranscript = vi.fn();
    render(<Harness onTranscript={onTranscript} />);
    await userEvent.click(mic());
    act(() => {
      FakeRecognition.last.onerror?.({ error: code });
      FakeRecognition.last.onend?.();
    });
    expect(screen.getByRole('alert').textContent).toMatch(message);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('cancelling submits nothing', async () => {
    const onTranscript = vi.fn();
    render(<Harness onTranscript={onTranscript} />);
    await userEvent.click(mic());
    act(() => FakeRecognition.last.hear('delete everything', false));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    act(() => FakeRecognition.last.onend?.());
    expect(FakeRecognition.last.abort).toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe('falling back to Groq', () => {
  const transcribeOk: TranscribeAudio = async () => ({ text: 'Open a new tab.', error: null });

  it('moves to Groq after the browser service fails, on the next press only', async () => {
    const transcribe = vi.fn(transcribeOk);
    const onTranscript = vi.fn();
    render(<Harness groqAllowed transcribe={transcribe} onTranscript={onTranscript} />);
    await userEvent.click(mic());
    act(() => {
      FakeRecognition.last.onerror?.({ error: 'network' });
      FakeRecognition.last.onend?.();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/press the microphone again/i);

    await userEvent.click(mic());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await screen.findByText(/sent to Groq/);
    await waitFor(() => expect(FakeRecorder.last.state).toBe('recording'));
    await userEvent.click(mic());
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Open a new tab.'));
    expect(transcribe.mock.calls[0]?.[1]).toBe('audio/webm');
  });

  it('never records when Groq is not allowed, and says what to do', async () => {
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    render(<Harness />);
    await userEvent.click(mic());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/still type/);
  });

  it('uses Groq directly on Brave when allowed', async () => {
    Object.defineProperty(navigator, 'brave', { configurable: true, value: {} });
    render(<Harness groqAllowed transcribe={transcribeOk} />);
    await userEvent.click(mic());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  });

  it('explains a blocked microphone, and offers settings', async () => {
    Object.defineProperty(navigator, 'brave', { configurable: true, value: {} });
    getUserMedia.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    render(<Harness groqAllowed choice="groq" />);
    await userEvent.click(mic());
    expect((await screen.findByRole('alert')).textContent).toMatch(/blocked/);
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });

  it('shows Groq errors, such as free-tier limits', async () => {
    const transcribe: TranscribeAudio = async () => ({
      text: null,
      error: 'Groq’s free-tier limit for voice was reached.',
    });
    render(<Harness groqAllowed choice="groq" transcribe={transcribe} />);
    await userEvent.click(mic());
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    await userEvent.click(mic());
    expect((await screen.findByRole('alert')).textContent).toMatch(/free-tier/);
  });

  it('always releases the microphone after a recording', async () => {
    render(<Harness groqAllowed choice="groq" transcribe={transcribeOk} />);
    await userEvent.click(mic());
    await waitFor(() => expect(FakeRecorder.last.state).toBe('recording'));
    await userEvent.click(mic());
    await waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  describe('when the microphone is slow to open', () => {
    let openMic: (stream: unknown) => void;
    beforeEach(() => {
      getUserMedia.mockImplementation(() => new Promise((resolve) => (openMic = resolve)));
    });
    const stream = () => ({ getTracks: () => [track] });

    it('does not claim to be listening yet', async () => {
      render(<Harness groqAllowed choice="groq" transcribe={transcribeOk} />);
      await userEvent.click(mic());
      expect(screen.getByText('Getting the microphone ready…')).toBeTruthy();
      expect(screen.queryByText('Listening…')).toBeNull();
      await act(async () => openMic(stream()));
      expect(await screen.findByText('Listening…')).toBeTruthy();
    });

    it('a release before it opens records and sends nothing, and frees the microphone', async () => {
      const transcribe = vi.fn(transcribeOk);
      FakeRecorder.last = undefined as never;
      render(<Harness groqAllowed choice="groq" transcribe={transcribe} />);
      await userEvent.click(mic());
      await userEvent.click(mic());
      await act(async () => openMic(stream()));

      expect(FakeRecorder.last).toBeUndefined();
      expect(track.stop).toHaveBeenCalled();
      expect(transcribe).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toMatch(/longer/);
    });

    it('cancelling before it opens frees the microphone too', async () => {
      FakeRecorder.last = undefined as never;
      render(<Harness groqAllowed choice="groq" transcribe={transcribeOk} />);
      await userEvent.click(mic());
      await userEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
      await act(async () => openMic(stream()));
      expect(FakeRecorder.last).toBeUndefined();
      expect(track.stop).toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('cancelling discards the recording, and sends nothing', async () => {
    const transcribe = vi.fn(transcribeOk);
    render(<Harness groqAllowed choice="groq" transcribe={transcribe} />);
    await userEvent.click(mic());
    await waitFor(() => expect(FakeRecorder.last.state).toBe('recording'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    await waitFor(() => expect(track.stop).toHaveBeenCalled());
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('releases the microphone when the page goes away', async () => {
    const { unmount } = render(<Harness groqAllowed choice="groq" transcribe={transcribeOk} />);
    await userEvent.click(mic());
    await waitFor(() => expect(FakeRecorder.last.state).toBe('recording'));
    unmount();
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops by itself at the time limit, so it can never run on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness groqAllowed choice="groq" transcribe={transcribeOk} />);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(mic());
    await vi.waitFor(() => expect(FakeRecorder.last.state).toBe('recording'));
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(FakeRecorder.last.state).toBe('inactive');
    vi.useRealTimers();
  });

  it('calls back when listening starts, so speech output can stop', async () => {
    const onListeningStart = vi.fn();
    render(<Harness onListeningStart={onListeningStart} />);
    await userEvent.click(mic());
    expect(onListeningStart).toHaveBeenCalled();
  });
});
