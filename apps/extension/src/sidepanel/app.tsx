import type { TabInfo } from '@dopilot/shared';
import {
  ActionList,
  Brand,
  CommandComposer,
  ConfirmBar,
  ConversationView,
  CurrentTab,
  groqShortLabel,
  groqTone,
  IconButton,
  StatusPill,
  TabList,
  useCommandConsole,
} from '@dopilot/ui';
import type { ConsoleMessage } from '@dopilot/ui';
import { ArrowLeft, ChevronRight, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { executeCommand, stopAgent } from '@/lib/panel-client';
import { SettingsForm } from '@/settings/settings-form';
import { CONVERSATION_STORAGE_KEY, usePanelState } from './use-panel-state';

async function loadConversation(): Promise<ConsoleMessage[]> {
  const stored = await chrome.storage.session.get(CONVERSATION_STORAGE_KEY);
  const messages = stored[CONVERSATION_STORAGE_KEY];
  return Array.isArray(messages) ? (messages as ConsoleMessage[]) : [];
}

function saveConversation(messages: ConsoleMessage[]) {
  void chrome.storage.session.set({ [CONVERSATION_STORAGE_KEY]: messages });
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group border-t border-line">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 px-3 text-xs font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform duration-150 group-open:rotate-90"
        />
        {label}
      </summary>
      <div className="max-h-52 overflow-y-auto px-3 pb-3">{children}</div>
    </details>
  );
}

export function App() {
  const { state, failed, refresh } = usePanelState();
  const [showSettings, setShowSettings] = useState(false);

  const console_ = useCommandConsole({
    execute: (command, { confirmed }) => executeCommand(command, confirmed),
    load: loadConversation,
    save: saveConversation,
    onSettled: () => void refresh(),
  });

  if (showSettings) {
    return (
      <div className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
          <IconButton label="Back" onClick={() => setShowSettings(false)}>
            <ArrowLeft aria-hidden="true" className="size-4" />
          </IconButton>
          <h1 className="text-sm font-medium">Settings</h1>
        </header>
        <main className="animate-slide-in flex-1 overflow-y-auto p-4">
          <SettingsForm />
        </main>
      </div>
    );
  }

  const currentTab = state?.tabs.find((tab) => tab.id === state.currentTabId);
  const closeTab = (tab: TabInfo) =>
    console_.runCommand(
      { action: 'tab.close', target: { tabId: tab.id } },
      `Close tab ${tab.position}`,
    );
  const switchTab = (tab: TabInfo) =>
    console_.runCommand(
      { action: 'tab.switch', target: { tabId: tab.id } },
      `Switch to tab ${tab.position}`,
    );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <Brand compact />
        <div className="flex items-center gap-1">
          {state && <StatusPill tone={groqTone(state.groq)} label={groqShortLabel(state.groq)} />}
          {failed && <StatusPill tone="danger" label="Extension error" />}
          <IconButton label="Settings" onClick={() => setShowSettings(true)}>
            <Settings aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-y border-line px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <CurrentTab
            tab={currentTab}
            emptyLabel={state ? 'No active tab' : 'Loading…'}
            disabled={console_.busy}
            onBack={() => console_.runCommand({ action: 'tab.back' }, 'go back')}
            onForward={() => console_.runCommand({ action: 'tab.forward' }, 'go forward')}
            onReload={() => console_.runCommand({ action: 'tab.reload' }, 'reload')}
          />
        </div>
        <IconButton
          label="New tab"
          className="size-7"
          disabled={console_.busy}
          onClick={() => console_.runCommand({ action: 'tab.new' }, 'new tab')}
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </IconButton>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        <ConversationView
          messages={console_.messages}
          onSwitchTab={switchTab}
          emptyState={
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-56 text-[13px] leading-relaxed text-muted">
                Type a browser command below. Nothing has been run yet.
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {['new tab', 'list tabs', 'help'].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => console_.submit(example)}
                    className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition duration-150 hover:bg-raised hover:text-ink"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          }
        />
      </main>

      <div className="shrink-0">
        {state && (
          <>
            <Collapsible label={`Open tabs (${state.tabs.length})`}>
              <TabList
                tabs={state.tabs}
                currentTabId={state.currentTabId}
                onSwitch={switchTab}
                onClose={closeTab}
              />
            </Collapsible>
            <Collapsible label={`Recent actions (${state.recentActions.length})`}>
              <ActionList actions={state.recentActions} />
            </Collapsible>
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
        {console_.confirmation && (
          <ConfirmBar
            confirmation={console_.confirmation}
            onConfirm={console_.confirm}
            onDecline={console_.decline}
          />
        )}
        <CommandComposer
          onSubmit={console_.submit}
          canStop={console_.busy}
          onStop={() => {
            console_.stop();
            void stopAgent();
          }}
        />
      </div>
    </div>
  );
}
