import type { AgentMetrics, TabInfo } from '@dopilot/shared';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AgentTimeline } from './agent-run.js';
import { Button } from './button.js';
import { TabList } from './tabs.js';
import type { ConfirmationRequest, ConsoleMessage } from './use-command-console.js';

export interface ConversationViewProps {
  messages: ConsoleMessage[];
  /** Shown when there are no messages yet. */
  emptyState: ReactNode;
  onSwitchTab?: (tab: TabInfo) => void;
  /** Runs an instruction again, from the button on a task that failed. */
  onRetry?: (instruction: string) => void;
  /** Only extension pages pass this. */
  onOpenSettings?: () => void;
}

/** How long it took and what it cost, in the same few words whichever way it ran. */
export function describeMetrics(metrics: AgentMetrics): string {
  const parts: string[] = [];
  if (metrics.totalMs !== null) parts.push(`${(metrics.totalMs / 1000).toFixed(1)}s`);
  parts.push(
    metrics.modelRequests === 0
      ? 'no AI needed'
      : metrics.modelRequests === 1
        ? '1 AI request'
        : `${metrics.modelRequests} AI requests`,
  );
  const tokens = metrics.promptTokens + metrics.completionTokens;
  if (tokens > 0) parts.push(`${tokens.toLocaleString('en')} tokens`);
  return parts.join(' · ');
}

function MessageBubble({
  message,
  onSwitchTab,
  onRetry,
  onOpenSettings,
}: {
  message: ConsoleMessage;
  onSwitchTab?: ((tab: TabInfo) => void) | undefined;
  onRetry?: ((instruction: string) => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
}) {
  if (message.role === 'user') {
    return (
      <div className="animate-rise flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {message.text}
        </p>
      </div>
    );
  }

  const tone =
    message.status === 'error'
      ? 'text-danger'
      : message.status === 'pending'
        ? 'text-muted animate-breathe'
        : 'text-ink';

  return (
    <div className="animate-rise">
      <p className={`text-sm break-words whitespace-pre-wrap ${tone}`}>{message.text}</p>
      {message.hint && <p className="mt-0.5 text-xs text-muted">{message.hint}</p>}
      {((message.retry && onRetry) || (message.action === 'settings' && onOpenSettings)) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {message.action === 'settings' && onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-ink transition duration-150 hover:bg-raised"
            >
              Open settings
            </button>
          )}
          {message.retry && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.retry as string)}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-muted transition duration-150 hover:bg-raised hover:text-ink"
            >
              Try again
            </button>
          )}
        </div>
      )}
      {message.steps && message.steps.length > 0 && (
        <details className="group mt-1.5">
          <summary className="cursor-pointer list-none text-xs text-faint hover:text-ink [&::-webkit-details-marker]:hidden">
            {message.steps.length === 1 ? '1 step' : `${message.steps.length} steps`}
            {message.metrics && ` · ${describeMetrics(message.metrics)}`}
          </summary>
          <div className="mt-2">
            <AgentTimeline entries={message.steps} />
          </div>
        </details>
      )}
      {message.tabs && (
        <div className="mt-2 rounded-xl border border-line bg-surface p-1">
          <TabList tabs={message.tabs} {...(onSwitchTab && { onSwitch: onSwitchTab })} />
        </div>
      )}
    </div>
  );
}

const NEAR_BOTTOM_PX = 120;

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export function ConversationView({
  messages,
  emptyState,
  onSwitchTab,
  onRetry,
  onOpenSettings,
}: ConversationViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const lastIsUser = messages.at(-1)?.role === 'user' || messages.at(-2)?.role === 'user';

  useEffect(() => {
    // Someone reading back through the conversation should not be dragged away from it,
    // unless they have just sent something themselves.
    const parent = scrollParent(endRef.current);
    const distance = parent ? parent.scrollHeight - parent.scrollTop - parent.clientHeight : 0;
    if (lastIsUser || distance < NEAR_BOTTOM_PX) {
      endRef.current?.scrollIntoView?.({ block: 'end' });
    }
  }, [count, lastIsUser]);

  if (count === 0) return <>{emptyState}</>;

  return (
    <div role="log" aria-label="Conversation" aria-live="polite" className="flex flex-col gap-4">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          onSwitchTab={onSwitchTab}
          onRetry={onRetry}
          onOpenSettings={onOpenSettings}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

export interface ConfirmBarProps {
  confirmation: ConfirmationRequest;
  onConfirm: () => void;
  onDecline: () => void;
}

export function ConfirmBar({ confirmation, onConfirm, onDecline }: ConfirmBarProps) {
  return (
    <div
      role="alertdialog"
      aria-label="Confirm action"
      className="animate-rise flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
    >
      <p className="min-w-0 flex-1 basis-40 text-sm break-words">{confirmation.prompt}</p>
      <Button onClick={onDecline}>Keep open</Button>
      <Button variant="danger" onClick={onConfirm}>
        Close tab
      </Button>
    </div>
  );
}
