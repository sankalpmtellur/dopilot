import {
  COMMAND_EXAMPLES,
  commandError,
  describeCommand,
  isAgentActive,
  parseCommand,
} from '@dopilot/shared';
import type {
  AgentFailureKind,
  AgentMetrics,
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
  metrics?: AgentMetrics;
  /** The instruction to run again, when trying again could help. */
  retry?: string;
  /** Whose problem this is, when that is not obvious from the message. */
  hint?: string;
  /** Something is missing from settings, so a way there is offered. */
  action?: 'settings';
}

export interface ConfirmationRequest {
  prompt: string;
  command: BrowserCommand;
  messageId: string;
}

type Action =
  | { type: 'add'; messages: ConsoleMessage[] }
  | { type: 'update'; id: string; changes: Partial<ConsoleMessage> }
  | { type: 'remove'; id: string }
  | { type: 'hydrate'; messages: ConsoleMessage[] }
  | { type: 'clear' };

const MAX_MESSAGES = 100;

export function consoleReducer(state: ConsoleMessage[], action: Action): ConsoleMessage[] {
  switch (action.type) {
    case 'add': {
      const known = new Set(state.map((message) => message.id));
      const added = action.messages.filter((message) => !known.has(message.id));
      // Called on every state update, and a new array would redraw and save for nothing.
      if (added.length === 0) return state;
      return [...state, ...added].slice(-MAX_MESSAGES);
    }
    case 'update':
      return state.map((message) =>
        message.id === action.id ? { ...message, ...action.changes } : message,
      );
    case 'remove':
      return state.filter((message) => message.id !== action.id);
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

export const HELP_TEXT = `Say what you want in your own words, such as “Open 5 new tabs” or “Summarize this page”. These exact commands also work:\n${COMMAND_EXAMPLES.map(
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

const FAILURE_HINTS: Partial<Record<AgentFailureKind, string>> = {
  key: 'Check your Groq key in Dopilot’s settings.',
  model: 'This came from the AI model, not your browser. Another model may work.',
  rate_limit: 'This is Groq’s free-tier limit. It clears by itself.',
  network: 'This looks like a connection problem.',
};

/** Retrying cannot help when the user said no or only they can get past something. */
const NOT_RETRYABLE: ReadonlySet<AgentFailureKind> = new Set(['declined', 'blocked', 'key']);

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
          // Stopping something on purpose is not an error.
          status: result.ok ? 'success' : result.code === 'cancelled' ? 'info' : 'error',
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
        const startingId = createId();
        dispatch({
          type: 'add',
          messages: [
            { id: createId(), role: 'user', text: instruction, status: 'info' },
            { id: startingId, role: 'dopilot', text: 'Starting…', status: 'pending' },
          ],
        });
        void latest.current.startTask(instruction).then(
          (problem) => {
            dispatch({ type: 'remove', id: startingId });
            if (!problem) return;
            dispatch({
              type: 'add',
              messages: [
                {
                  id: createId(),
                  role: 'dopilot',
                  text: problem,
                  status: 'error',
                  ...(/API key/i.test(problem) && { action: 'settings' as const }),
                },
              ],
            });
          },
          () => {
            dispatch({ type: 'remove', id: startingId });
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
          ...(run.metrics && { metrics: run.metrics }),
          ...(run.status === 'failed' &&
            !(run.failureKind && NOT_RETRYABLE.has(run.failureKind)) && {
              retry: run.instruction,
            }),
          ...(run.failureKind &&
            FAILURE_HINTS[run.failureKind] && { hint: FAILURE_HINTS[run.failureKind] as string }),
          ...((run.failureKind === 'key' || run.failureKind === 'model') && {
            action: 'settings' as const,
          }),
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
