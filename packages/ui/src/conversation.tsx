import type { TabInfo } from '@dopilot/shared';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './button.js';
import { TabList } from './tabs.js';
import type { ConfirmationRequest, ConsoleMessage } from './use-command-console.js';

export interface ConversationViewProps {
  messages: ConsoleMessage[];
  /** Shown when there are no messages yet. */
  emptyState: ReactNode;
  onSwitchTab?: (tab: TabInfo) => void;
}

function MessageBubble({
  message,
  onSwitchTab,
}: {
  message: ConsoleMessage;
  onSwitchTab?: ((tab: TabInfo) => void) | undefined;
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
      {message.tabs && (
        <div className="mt-2 rounded-xl border border-line bg-surface p-1">
          <TabList tabs={message.tabs} {...(onSwitchTab && { onSwitch: onSwitchTab })} />
        </div>
      )}
    </div>
  );
}

export function ConversationView({ messages, emptyState, onSwitchTab }: ConversationViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);

  if (count === 0) return <>{emptyState}</>;

  return (
    <div role="log" aria-label="Conversation" aria-live="polite" className="flex flex-col gap-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onSwitchTab={onSwitchTab} />
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
