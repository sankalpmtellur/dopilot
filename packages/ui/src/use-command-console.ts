import {
  COMMAND_EXAMPLES,
  commandError,
  describeCommand,
  isAgentActive,
  parseCommand,
} from '@dopilot/shared';
import type {
  AgentRunView,
  AgentTimelineEntry,
  BrowserCommand,
  CommandResult,
  TabInfo,
} from '@dopilot/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

export interface ConsoleMessage {
  id: string;
  role: 'user' | 'dopilot';
  text: string;
  status: 'pending' | 'success' | 'error' | 'info';
  tabs?: TabInfo[];
  /** What the agent did to reach this answer. */
  steps?: AgentTimelineEntry[];
}

export interface ConfirmationRequest {
  prompt: string;
  command: BrowserCommand;
  messageId: string;
}

type Action =
  | { type: 'add'; messages: ConsoleMessage[] }
  | { type: 'update'; id: string; changes: Partial<ConsoleMessage> }
  | { type: 'hydrate'; messages: ConsoleMessage[] }
  | { type: 'clear' };

const MAX_MESSAGES = 100;

export function consoleReducer(state: ConsoleMessage[], action: Action): ConsoleMessage[] {
  switch (action.type) {
    case 'add': {
      const known = new Set(state.map((message) => message.id));
      const added = action.messages.filter((message) => !known.has(message.id));
      return [...state, ...added].slice(-MAX_MESSAGES);
    }
    case 'update':
      return state.map((message) =>
        message.id === action.id ? { ...message, ...action.changes } : message,
      );
    case 'hydrate': {
      // Messages typed before stored history finished loading are kept after it.
      const stored = new Set(action.messages.map((message) => message.id));
      return [...action.messages, ...state.filter((message) => !stored.has(message.id))].slice(
        -MAX_MESSAGES,
      );
    }
    case 'clear':
      return [];
  }
}

export const HELP_TEXT = `I understand these exact commands:\n${COMMAND_EXAMPLES.map(
  (example) => `• ${example}`,
).join('\n')}`;

export const UNKNOWN_TEXT =
  'I can’t understand natural language yet, so nothing was done. Type “help” to see the commands I know.';

export type ExecuteCommand = (
  command: BrowserCommand,
  options: { confirmed: boolean; signal: AbortSignal },
) => Promise<CommandResult>;

export interface CommandConsoleOptions {
  execute: ExecuteCommand;
  load?: () => Promise<ConsoleMessage[]>;
  save?: (messages: ConsoleMessage[]) => void;
  /** Runs after each browser command, so views can refresh. */
  onSettled?: () => void;
  /**
   * Hands anything that is not an exact command to the agent. Resolves to why it could
   * not start, or null. Without this, such text is simply reported as not understood.
   */
  startTask?: (instruction: string) => Promise<string | null>;
  onClear?: () => void;
}

function createId(): string {
  return crypto.randomUUID();
}

/** Conversation state for both the website and the side panel. Results are never simulated. */
export function useCommandConsole({
  execute,
  load,
  save,
  onSettled,
  startTask,
  onClear,
}: CommandConsoleOptions) {
  const [messages, dispatch] = useReducer(consoleReducer, []);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const hydrated = useRef(!load);

  // Callers may pass new function identities on each render.
  const latest = useRef({ execute, load, save, onSettled, startTask, onClear });
  useEffect(() => {
    latest.current = { execute, load, save, onSettled, startTask, onClear };
  });

  useEffect(() => {
    let active = true;
    void latest.current.load?.().then((stored) => {
      if (active) {
        hydrated.current = true;
        dispatch({ type: 'hydrate', messages: stored });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hydrated.current) {
      latest.current.save?.(messages.filter((message) => message.status !== 'pending'));
    }
  }, [messages]);

  const run = useCallback(
    async (command: BrowserCommand, messageId: string, confirmed: boolean) => {
      const abort = new AbortController();
      controller.current = abort;
      setBusy(true);

      const cancelled = new Promise<CommandResult>((resolve) => {
        abort.signal.addEventListener('abort', () =>
          resolve(commandError('cancelled', 'Stopped.')),
        );
      });

      let result: CommandResult;
      try {
        result = await Promise.race([
          latest.current.execute(command, { confirmed, signal: abort.signal }),
          cancelled,
        ]);
      } catch {
        result = commandError('execution_failed', 'That action could not be completed.');
      }

      controller.current = null;
      setBusy(false);

      if (!result.ok && result.code === 'confirmation_required') {
        setConfirmation({ prompt: result.message, command, messageId });
        dispatch({
          type: 'update',
          id: messageId,
          changes: { text: result.message, status: 'info' },
        });
        return;
      }

      dispatch({
        type: 'update',
        id: messageId,
        changes: {
          text: result.message,
          status: result.ok ? 'success' : 'error',
          ...(result.ok && result.tabs && { tabs: result.tabs }),
        },
      });
      latest.current.onSettled?.();
    },
    [],
  );

  const runCommand = useCallback(
    (command: BrowserCommand, label: string = describeCommand(command)) => {
      if (controller.current) return;
      setConfirmation(null);
      const messageId = createId();
      dispatch({
        type: 'add',
        messages: [
          { id: createId(), role: 'user', text: label, status: 'info' },
          { id: messageId, role: 'dopilot', text: 'Working…', status: 'pending' },
        ],
      });
      void run(command, messageId, false);
    },
    [run],
  );

  const submit = useCallback(
    (text: string) => {
      const parsed = parseCommand(text);
      if (parsed.kind === 'command') {
        runCommand(parsed.command, text.trim());
        return;
      }

      if (parsed.kind === 'unknown' && latest.current.startTask) {
        const instruction = text.trim();
        dispatch({
          type: 'add',
          messages: [{ id: createId(), role: 'user', text: instruction, status: 'info' }],
        });
        void latest.current.startTask(instruction).then(
          (problem) => {
            if (!problem) return;
            dispatch({
              type: 'add',
              messages: [{ id: createId(), role: 'dopilot', text: problem, status: 'error' }],
            });
          },
          () => {
            dispatch({
              type: 'add',
              messages: [
                {
                  id: createId(),
                  role: 'dopilot',
                  text: 'That task could not be started.',
                  status: 'error',
                },
              ],
            });
          },
        );
        return;
      }

      const reply: Pick<ConsoleMessage, 'text' | 'status'> =
        parsed.kind === 'help'
          ? { text: HELP_TEXT, status: 'info' }
          : parsed.kind === 'invalid'
            ? { text: parsed.message, status: 'error' }
            : { text: UNKNOWN_TEXT, status: 'info' };

      dispatch({
        type: 'add',
        messages: [
          { id: createId(), role: 'user', text: text.trim(), status: 'info' },
          { id: createId(), role: 'dopilot', ...reply },
        ],
      });
    },
    [runCommand],
  );

  const confirm = useCallback(() => {
    if (!confirmation) return;
    setConfirmation(null);
    dispatch({
      type: 'update',
      id: confirmation.messageId,
      changes: { text: 'Working…', status: 'pending' },
    });
    void run(confirmation.command, confirmation.messageId, true);
  }, [confirmation, run]);

  const decline = useCallback(() => {
    if (!confirmation) return;
    setConfirmation(null);
    dispatch({
      type: 'update',
      id: confirmation.messageId,
      changes: { text: 'Kept the tab open.', status: 'info' },
    });
  }, [confirmation]);

  const stop = useCallback(() => controller.current?.abort(), []);
  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
    latest.current.onClear?.();
  }, []);

  /** Adds a finished task's result to the conversation, once. */
  const reportRun = useCallback((run: AgentRunView | null | undefined) => {
    if (!run || isAgentActive(run.status)) return;
    const text =
      run.status === 'completed'
        ? (run.summary ?? 'Done.')
        : (run.error ?? run.summary ?? 'The task stopped.');
    dispatch({
      type: 'add',
      messages: [
        {
          id: `run-${run.id}`,
          role: 'dopilot',
          text,
          status:
            run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : 'info',
          steps: run.timeline,
        },
      ],
    });
  }, []);

  return {
    messages,
    busy,
    confirmation,
    submit,
    runCommand,
    confirm,
    decline,
    stop,
    clear,
    reportRun,
  };
}
