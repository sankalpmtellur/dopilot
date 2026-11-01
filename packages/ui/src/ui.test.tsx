// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { CommandResult } from '@dopilot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionList } from './activity.js';
import { CommandComposer } from './composer.js';
import { ConfirmBar, ConversationView } from './conversation.js';
import { TabList } from './tabs.js';
import { useCommandConsole, UNKNOWN_TEXT } from './use-command-console.js';
import type { ExecuteCommand } from './use-command-console.js';

afterEach(cleanup);

function Harness({ execute }: { execute: ExecuteCommand }) {
  const consoleState = useCommandConsole({ execute });
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

  it('keeps the microphone disabled', () => {
    render(<Harness execute={vi.fn()} />);
    const mic = screen.getByRole('button', { name: /voice input, coming soon/i });
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
