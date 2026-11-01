// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { AgentRunView, CommandResult } from '@dopilot/shared';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionList } from './activity.js';
import { AgentPanel } from './agent-run.js';
import { CommandComposer } from './composer.js';
import { ConfirmBar, ConversationView } from './conversation.js';
import { TabList } from './tabs.js';
import { useCommandConsole, UNKNOWN_TEXT } from './use-command-console.js';
import type { ExecuteCommand } from './use-command-console.js';

afterEach(cleanup);

function Harness({
  execute,
  startTask,
  run,
}: {
  execute: ExecuteCommand;
  startTask?: (instruction: string) => Promise<string | null>;
  run?: AgentRunView;
}) {
  const consoleState = useCommandConsole({ execute, ...(startTask && { startTask }) });
  const { reportRun } = consoleState;
  useEffect(() => reportRun(run), [reportRun, run]);
  return (
    <div>
      <ConversationView messages={consoleState.messages} emptyState={<p>Nothing yet</p>} />
      {consoleState.confirmation && (
        <ConfirmBar
          confirmation={consoleState.confirmation}
          onConfirm={consoleState.confirm}
          onDecline={consoleState.decline}
        />
      )}
      <CommandComposer
        onSubmit={consoleState.submit}
        onStop={consoleState.stop}
        canStop={consoleState.busy}
      />
    </div>
  );
}

async function type(text: string) {
  await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), `${text}{Enter}`);
}

describe('command console', () => {
  it('shows the empty state until something happens', () => {
    render(<Harness execute={vi.fn()} />);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
  });

  it('shows the actual result of a command', async () => {
    const execute = vi.fn<ExecuteCommand>(async () => ({ ok: true, message: 'Opened a new tab.' }));
    render(<Harness execute={execute} />);
    await type('new tab');
    expect(await screen.findByText('Opened a new tab.')).toBeTruthy();
    expect(execute.mock.calls[0]?.[0]).toEqual({ action: 'tab.new' });
  });

  it('shows the actual error of a command', async () => {
    render(
      <Harness
        execute={async () => ({ ok: false, code: 'no_history', message: 'There is no page.' })}
      />,
    );
    await type('go back');
    expect(await screen.findByText('There is no page.')).toBeTruthy();
  });

  it('does not run or pretend to understand natural language', async () => {
    const execute = vi.fn<ExecuteCommand>();
    render(<Harness execute={execute} />);
    await type('book me a flight');
    expect(await screen.findByText(UNKNOWN_TEXT)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses unsafe addresses before sending them', async () => {
    const execute = vi.fn<ExecuteCommand>();
    render(<Harness execute={execute} />);
    await type('open chrome://settings');
    expect(await screen.findByText(/only http and https/i)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks before closing, and only then sends the confirmed command', async () => {
    const execute = vi.fn<ExecuteCommand>(
      async (_command, { confirmed }): Promise<CommandResult> =>
        confirmed
          ? { ok: true, message: 'Closed.' }
          : { ok: false, code: 'confirmation_required', message: 'Close “Mail”?' },
    );
    render(<Harness execute={execute} />);
    await type('close tab');
    await screen.findByRole('alertdialog');
    expect(execute).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(await screen.findByText('Closed.')).toBeTruthy();
    expect(execute.mock.calls[1]?.[1].confirmed).toBe(true);
  });

  it('declining sends nothing further', async () => {
    const execute = vi.fn<ExecuteCommand>(async () => ({
      ok: false,
      code: 'confirmation_required',
      message: 'Close “Mail”?',
    }));
    render(<Harness execute={execute} />);
    await type('close tab');
    await userEvent.click(await screen.findByRole('button', { name: 'Keep open' }));
    expect(await screen.findByText('Kept the tab open.')).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('can stop a command that has not finished', async () => {
    const execute = vi.fn<ExecuteCommand>(() => new Promise(() => undefined));
    render(<Harness execute={execute} />);
    await type('reload');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped.')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it('shows a disabled microphone if a surface offers no voice', () => {
    render(<Harness execute={vi.fn()} />);
    const mic = screen.getByRole('button', { name: /voice input is not available/i });
    expect((mic as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('lists', () => {
  it('renders tabs without details, and offers no actions on restricted tabs', async () => {
    const onSwitch = vi.fn();
    render(
      <TabList
        onSwitch={onSwitch}
        onClose={vi.fn()}
        tabs={[
          { id: 1, position: 1, active: false, restricted: false },
          { id: 2, position: 2, active: false, restricted: true, title: 'Settings' },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Tab 1' }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close Settings' })).toBeNull();
  });

  it('renders action results, including failures', () => {
    render(
      <ActionList
        actions={[
          {
            id: '1',
            at: 0,
            source: 'website',
            summary: 'Go back',
            ok: false,
            detail: 'There is no page to go to.',
          },
        ]}
      />,
    );
    expect(screen.getByText('Go back')).toBeTruthy();
    expect(screen.getByText(/There is no page to go to/)).toBeTruthy();
  });

  it('has an accurate empty state', () => {
    render(<ActionList actions={[]} />);
    expect(screen.getByText('No browser actions yet.')).toBeTruthy();
  });
});

const baseRun: AgentRunView = {
  id: 'run-1',
  instruction: 'Open Wikipedia and search for AI',
  source: 'panel',
  status: 'executing',
  notice: null,
  model: 'model-a',
  startedAt: 0,
  finishedAt: null,
  actionCount: 2,
  readPageContent: false,
  maxActions: 15,
  timeline: [
    {
      id: '1',
      at: 0,
      kind: 'act',
      status: 'done',
      label: 'Opening https://wikipedia.org',
      detail: 'Opened.',
    },
    { id: '2', at: 0, kind: 'act', status: 'running', label: 'Typing' },
  ],
  approval: null,
  summary: null,
  error: null,
};

describe('handing tasks to the agent', () => {
  it('sends natural language to the agent, but exact commands stay local', async () => {
    const execute = vi.fn<ExecuteCommand>(async () => ({ ok: true, message: 'Opened a new tab.' }));
    const startTask = vi.fn(async () => null);
    render(<Harness execute={execute} startTask={startTask} />);

    await type('new tab');
    expect(startTask).not.toHaveBeenCalled();
    await type('Open YouTube.');
    expect(startTask).toHaveBeenCalledWith('Open YouTube.');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never sends unsafe addresses to the agent', async () => {
    const startTask = vi.fn(async () => null);
    render(<Harness execute={vi.fn()} startTask={startTask} />);
    await type('open chrome://settings');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('shows why a task could not start', async () => {
    render(<Harness execute={vi.fn()} startTask={async () => 'Add your Groq API key first.'} />);
    await type('find me a flight');
    expect(await screen.findByText('Add your Groq API key first.')).toBeTruthy();
  });

  it('adds a finished task once, with its steps', async () => {
    const run = { ...baseRun, status: 'completed' as const, summary: 'All done.' };
    const { rerender } = render(<Harness execute={vi.fn()} run={run} />);
    rerender(<Harness execute={vi.fn()} run={{ ...run }} />);
    expect(screen.getAllByText('All done.')).toHaveLength(1);
    expect(screen.getByText('2 steps')).toBeTruthy();
  });

  it('shows a failure as a failure, not a success', () => {
    const run = { ...baseRun, status: 'failed' as const, error: 'Reached the limit.' };
    render(<Harness execute={vi.fn()} run={run} />);
    expect(screen.getByText('Reached the limit.').className).toContain('text-danger');
  });
});

describe('AgentPanel vision', () => {
  const looking: AgentRunView = {
    ...baseRun,
    status: 'observing',
    timeline: [{ id: 'v', at: 0, kind: 'vision', status: 'running', label: 'Looking at the page' }],
  };
  const consent = {
    id: 'a',
    kind: 'screenshot' as const,
    title: 'Send a screenshot of a.com to Groq?',
    detail: 'Groq will process this image.',
    screenshotId: 's1',
  };
  const waiting: AgentRunView = { ...baseRun, status: 'waiting_for_approval', approval: consent };

  it('says clearly when a screenshot is being used', () => {
    render(<AgentPanel run={looking} onStop={vi.fn()} />);
    expect(screen.getByText(/looking at this page, using a screenshot/i)).toBeTruthy();
  });

  it('previews what will be sent, in extension pages', async () => {
    const load = vi.fn(async () => 'data:image/jpeg;base64,/9j/');
    render(
      <AgentPanel
        run={waiting}
        onStop={vi.fn()}
        loadScreenshot={load}
        onAnswerApproval={vi.fn()}
      />,
    );
    expect(await screen.findByAltText('The screenshot that would be sent')).toBeTruthy();
    expect(load).toHaveBeenCalledWith('s1');
  });

  it('shows no image on the website', () => {
    render(<AgentPanel run={waiting} onStop={vi.fn()} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('AgentPanel', () => {
  it.each([
    ['thinking', 'Thinking'],
    ['observing', 'Observing'],
    ['executing', 'Executing'],
    ['waiting_for_approval', 'Waiting for approval'],
  ] as const)('shows the %s status with a Stop button', (status, label) => {
    render(<AgentPanel run={{ ...baseRun, status }} onStop={vi.fn()} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeTruthy();
  });

  it('shows the task, its timeline and progress', () => {
    render(<AgentPanel run={baseRun} onStop={vi.fn()} />);
    expect(screen.getByText('Open Wikipedia and search for AI')).toBeTruthy();
    expect(screen.getByText('Opening https://wikipedia.org')).toBeTruthy();
    expect(screen.getByText('Opened.')).toBeTruthy();
    expect(screen.getByText('2 of 15 actions')).toBeTruthy();
  });

  it('stops when asked', async () => {
    const onStop = vi.fn();
    render(<AgentPanel run={baseRun} onStop={onStop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop task' }));
    expect(onStop).toHaveBeenCalled();
  });

  it('shows retry notices', () => {
    render(
      <AgentPanel
        run={{ ...baseRun, notice: 'Rate limited by Groq. Retrying in 7s.' }}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText('Rate limited by Groq. Retrying in 7s.')).toBeTruthy();
  });

  const approval = {
    id: 'a1',
    kind: 'action' as const,
    title: 'Click “Delete”?',
    detail: 'This deletes something.',
  };
  const waiting = { ...baseRun, status: 'waiting_for_approval' as const, approval };

  it('keeps the prompt in view by holding back the steps while waiting', () => {
    render(<AgentPanel run={waiting} onStop={vi.fn()} onAnswerApproval={vi.fn()} />);
    expect(screen.queryByText('Opening https://wikipedia.org')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeTruthy();
  });

  it('lets extension pages answer an approval', async () => {
    const onAnswer = vi.fn();
    render(<AgentPanel run={waiting} onStop={vi.fn()} onAnswerApproval={onAnswer} />);
    expect(screen.getByRole('alertdialog').textContent).toContain('Click “Delete”?');
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onAnswer).toHaveBeenCalledWith(approval, false);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAnswer).toHaveBeenCalledWith(approval, true);
  });

  it('gives the website no way to answer, only a pointer to where to do it', () => {
    render(<AgentPanel run={waiting} onStop={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Dopilot side panel or window/);
  });
});
