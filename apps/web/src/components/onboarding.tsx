'use client';

import { Button, IconButton } from '@dopilot/ui';
import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExtensionConnection } from '@/hooks/use-extension';

interface StepProps {
  index: number;
  title: string;
  done: boolean;
  children: ReactNode;
}

function Step({ index, title, done, children }: StepProps) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums ${
          done ? 'bg-primary text-on-primary' : 'border border-line text-muted'
        }`}
      >
        {done ? <Check className="size-3" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </p>
        <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

export interface OnboardingProps {
  connection: ExtensionConnection;
  hasRunCommand: boolean;
  onOpenSettings: () => void;
  onTryCommand: (command: string) => void;
  onDismiss: () => void;
}

export function Onboarding({
  connection,
  hasRunCommand,
  onOpenSettings,
  onTryCommand,
  onDismiss,
}: OnboardingProps) {
  const connected = connection.status === 'connected';
  const groq = connected ? connection.state.groq : null;

  return (
    <section
      aria-labelledby="onboarding-title"
      className="animate-rise rounded-2xl border border-line bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="onboarding-title" className="text-base font-semibold tracking-tight">
            Set up Dopilot
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Dopilot works through a browser extension, using your own Groq key.
          </p>
        </div>
        <IconButton label="Dismiss setup guide" onClick={onDismiss}>
          <X aria-hidden="true" className="size-4" />
        </IconButton>
      </div>

      <ol className="mt-4 flex flex-col gap-4">
        <Step index={1} title="Add the extension" done={connected}>
          {connected ? (
            'Connected.'
          ) : (
            <>
              Dopilot needs desktop Chrome or Brave. Run <code>pnpm build</code>, open{' '}
              <code>chrome://extensions</code> or <code>brave://extensions</code>, turn on Developer
              mode, and load <code>apps/extension/dist</code> unpacked. This page will notice
              automatically.
            </>
          )}
        </Step>

        <Step index={2} title="Add your Groq API key" done={groq?.connection.state === 'connected'}>
          <p>
            {groq?.connection.state === 'connected'
              ? `Saved as ${groq.maskedKey} and connected.`
              : groq?.configured
                ? `Saved as ${groq.maskedKey}. Test it in the extension to finish this step.`
                : 'Your key is entered in the extension, so this website never sees it. Exact commands like “new tab” work without one.'}
          </p>
          {connected && groq?.connection.state !== 'connected' && (
            <Button className="mt-2" onClick={onOpenSettings}>
              Open extension settings
            </Button>
          )}
        </Step>

        <Step index={3} title="Try a command" done={hasRunCommand}>
          <p>
            Dopilot acts on your real browser, shows each step, and asks before anything sensitive.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {['new tab', 'list tabs', 'help'].map((command) => (
              <button
                key={command}
                type="button"
                onClick={() => onTryCommand(command)}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition duration-150 hover:bg-raised hover:text-ink"
              >
                {command}
              </button>
            ))}
          </div>
        </Step>
      </ol>
    </section>
  );
}
