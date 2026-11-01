'use client';

import { describeGroqConnection } from '@dopilot/shared';
import { Button, groqTone, IconButton, StatusPill, ThemeSwitch } from '@dopilot/ui';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ExtensionConnection } from '@/hooks/use-extension';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-line py-5 last:border-b-0">
      <h3 className="text-xs font-medium tracking-wide text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

export interface SettingsDrawerProps {
  open: boolean;
  connection: ExtensionConnection;
  onClose: () => void;
  onOpenExtensionSettings: () => void;
  onShowGuide: () => void;
  onClearConversation: () => void;
}

export function SettingsDrawer({
  open,
  connection,
  onClose,
  onOpenExtensionSettings,
  onShowGuide,
  onClearConversation,
}: SettingsDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (element.showModal) element.showModal();
      else element.setAttribute('open', '');
    }
    if (!open && element.open) element.close?.();
  }, [open]);

  const connected = connection.status === 'connected';
  const state = connected ? connection.state : null;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="m-0 ml-auto h-dvh max-h-none w-full max-w-sm border-l border-line bg-canvas text-ink backdrop:bg-black/30 open:animate-slide-in"
    >
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between px-5">
          <h2 id="settings-title" className="text-[15px] font-semibold tracking-tight">
            Settings
          </h2>
          <IconButton label="Close settings" onClick={onClose}>
            <X aria-hidden="true" className="size-4" />
          </IconButton>
        </header>

        <div className="flex-1 overflow-y-auto px-5">
          <Section title="Groq API key">
            {state ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code data-testid="web-masked-key" className="text-[13px] text-muted">
                    {state.groq.maskedKey ?? 'No key saved'}
                  </code>
                  <StatusPill
                    tone={groqTone(state.groq)}
                    label={state.groq.configured ? 'Key saved' : 'Not set up'}
                  />
                </div>
                <p className="text-[13px] text-muted">{describeGroqConnection(state.groq)}</p>
                <p className="text-[13px] text-muted">
                  Model: {state.groq.selectedModel ?? 'Automatic'}
                </p>
              </>
            ) : (
              <p className="text-[13px] text-muted">Connect the extension to set up a key.</p>
            )}
            <p className="text-xs leading-relaxed text-faint">
              You add, test and remove your key in the extension. It stays there and goes only to
              Groq, so this website and our backend never receive it.
            </p>
            <div>
              <Button variant="primary" disabled={!connected} onClick={onOpenExtensionSettings}>
                Manage key in extension
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          </Section>

          <Section title="Extension">
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="text-muted">Status</span>
              <span>{state ? `Connected, v${state.extensionVersion}` : 'Not connected'}</span>
            </div>
            {state && (
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span className="text-muted">Tab details</span>
                <span>{state.tabDetailsAvailable ? 'Allowed' : 'Off'}</span>
              </div>
            )}
          </Section>

          <Section title="Appearance">
            <div>
              <ThemeSwitch />
            </div>
          </Section>

          <Section title="This website">
            <div className="flex flex-wrap gap-2">
              <Button onClick={onShowGuide}>Show setup guide</Button>
              <Button onClick={onClearConversation}>Clear conversation</Button>
            </div>
          </Section>
        </div>
      </div>
    </dialog>
  );
}
