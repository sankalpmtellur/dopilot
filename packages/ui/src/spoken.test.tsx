// @vitest-environment jsdom
import type { AgentRunView } from '@dopilot/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spokenForRun, useSpokenResponses } from './spoken.js';
import type { ConsoleMessage } from './use-command-console.js';

const base: AgentRunView = {
  id: 'r1',
  instruction: 'x',
  source: 'panel',
  status: 'thinking',
  notice: null,
  model: 'm',
  startedAt: 0,
  finishedAt: null,
  actionCount: 0,
  readPageContent: false,
  maxActions: 15,
  timeline: [],
  approval: null,
  summary: null,
  error: null,
};

const act = { id: '1', at: 0, kind: 'act' as const, status: 'done' as const };

describe('spokenForRun', () => {
  it('says nothing while thinking or only observing', () => {
    expect(spokenForRun(base)).toBeNull();
    expect(
      spokenForRun({
        ...base,
        timeline: [{ id: '1', at: 0, kind: 'observe', status: 'done', label: 'Reading the page' }],
      }),
    ).toBeNull();
  });

  it('confirms the first action in plain words', () => {
    expect(
      spokenForRun({
        ...base,
        timeline: [{ ...act, label: 'Opening https://www.youtube.com/' }],
      })?.text,
    ).toBe('Opening youtube.com.');
  });

  it('does not change what it says for later steps, so they are not all spoken', () => {
    const one = spokenForRun({ ...base, timeline: [{ ...act, label: 'Opening a new tab' }] });
    const two = spokenForRun({
      ...base,
      timeline: [
        { ...act, label: 'Opening a new tab' },
        { ...act, id: '2', label: 'Typing' },
      ],
    });
    expect(one?.key).toBe(two?.key);
  });

  it('says when approval is needed, without the details', () => {
    const run = {
      ...base,
      approval: { id: 'a', kind: 'action' as const, title: 'Click “Pay £400”?', detail: 'd' },
    };
    expect(spokenForRun(run)?.text).toBe('I need your approval.');
  });

  it('speaks only the first sentence of a final result', () => {
    expect(
      spokenForRun({ ...base, status: 'completed', summary: 'Opened YouTube. Also did more.' })
        ?.text,
    ).toBe('Opened YouTube.');
  });

  it('never reads page content aloud automatically', () => {
    const secret = 'Your balance is 4,200 and your code is 9921.';
    const spoken = spokenForRun({
      ...base,
      status: 'completed',
      summary: secret,
      readPageContent: true,
    });
    expect(spoken?.text).toBe('Done. The answer is on your screen.');
  });

  it('does not read out errors, which may quote the page', () => {
    expect(
      spokenForRun({ ...base, status: 'failed', error: 'Page said: secret 123' })?.text,
    ).not.toContain('secret');
  });

  it('confirms stopping', () => {
    expect(spokenForRun({ ...base, status: 'cancelled' })?.text).toBe('Stopped.');
  });
});

describe('useSpokenResponses', () => {
  const speak = vi.fn();
  const cancel = vi.fn();

  function Harness({
    run,
    messages = [],
  }: {
    run: AgentRunView | null;
    messages?: ConsoleMessage[];
  }) {
    useSpokenResponses({ run, messages });
    return null;
  }
  const done: AgentRunView = { ...base, status: 'completed', summary: 'Opened it.' };

  beforeEach(() => {
    localStorage.clear();
    speak.mockClear();
    cancel.mockClear();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(public text: string) {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is off by default', () => {
    render(<Harness run={done} />);
    expect(speak).not.toHaveBeenCalled();
  });

  it('speaks each thing once when on', () => {
    localStorage.setItem('dopilot.spoken', 'true');
    const { rerender } = render(<Harness run={done} />);
    rerender(<Harness run={{ ...done }} />);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]?.[0].text).toBe('Opened it.');
  });

  it('reads short command results, but never long ones or the agent’s twice', () => {
    localStorage.setItem('dopilot.spoken', 'true');
    const message = (id: string, text: string): ConsoleMessage => ({
      id,
      role: 'dopilot',
      text,
      status: 'success',
    });
    render(<Harness run={null} messages={[message('m1', 'Opened a new tab.')]} />);
    expect(speak.mock.calls[0]?.[0].text).toBe('Opened a new tab.');
    cleanup();
    speak.mockClear();
    render(<Harness run={null} messages={[message('m2', 'x'.repeat(500))]} />);
    render(<Harness run={null} messages={[message('run-r1', 'Long agent answer')]} />);
    expect(speak).not.toHaveBeenCalled();
  });

  it('can be interrupted, and stops when leaving', () => {
    localStorage.setItem('dopilot.spoken', 'true');
    const { unmount } = render(<Harness run={done} />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('works where speech is unavailable, without errors', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    localStorage.setItem('dopilot.spoken', 'true');
    expect(() => render(<Harness run={done} />)).not.toThrow();
  });
});
