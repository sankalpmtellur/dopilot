'use client';

import { agentStatusLabel, describeCommand, isAgentActive } from '@dopilot/shared';
import type { TabInfo } from '@dopilot/shared';
import {
  ActionList,
  AgentPanel,
  AgentTimeline,
  Brand,
  CommandComposer,
  ConversationView,
  CurrentTab,
  groqShortLabel,
  groqTone,
  IconButton,
  SpokenToggle,
  StatusPill,
  TabList,
  useCommandConsole,
  useSpokenResponses,
  useVoiceInput,
  VoiceButton,
  VoiceStatusLine,
} from '@dopilot/ui';
import { Activity, Globe, MessageSquare, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Onboarding } from '@/components/onboarding';
import { SettingsDrawer } from '@/components/settings-drawer';
import { useExtension } from '@/hooks/use-extension';
import { useStoredFlag } from '@/hooks/use-stored-flag';
import { loadConversation, saveConversation } from '@/lib/conversation-store';
import {
  openExtensionSettings,
  resetAgent,
  sendBrowserCommand,
  startAgentTask,
  stopAgentTask,
  transcribeThroughExtension,
} from '@/lib/extension-bridge';

type Section = 'chat' | 'browser' | 'activity';

const SECTIONS = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'activity', label: 'Activity', Icon: Activity },
] as const;

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2.5 flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wide text-faint uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ConsoleApp() {
  const { connection, refresh, extensionId } = useExtension();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<Section>('chat');
  const [guideDismissed, setGuideDismissed] = useStoredFlag('dopilot.guideDismissed');
  const [guideRequested, setGuideRequested] = useState(false);
  const [draft, setDraft] = useState('');

  const console_ = useCommandConsole({
    execute: (command, { signal }) => sendBrowserCommand(extensionId, command, signal),
    load: loadConversation,
    save: saveConversation,
    onSettled: () => void refresh(),
    startTask: async (instruction) => {
      const problem = await startAgentTask(extensionId, instruction);
      void refresh();
      return problem;
    },
    onClear: () => void resetAgent(extensionId),
  });

  const state = connection.status === 'connected' ? connection.state : null;
  const connected = state !== null;
  const currentTab = state?.tabs.find((tab) => tab.id === state.currentTabId);
  const run = state?.agent ?? null;
  const taskRunning = run !== null && isAgentActive(run.status);
  const { reportRun } = console_;
  useEffect(() => reportRun(run), [reportRun, run]);
  const spoken = useSpokenResponses({ run, messages: console_.messages });
  const stopTask = () => {
    console_.stop();
    spoken.interrupt();
    void stopAgentTask(extensionId).then(() => refresh());
  };
  const voice = useVoiceInput({
    choice: state?.preferences.voiceEngine ?? 'auto',
    groqAllowed: state?.preferences.speechFallback ?? false,
    transcribe: (audio, mimeType) => transcribeThroughExtension(extensionId, audio, mimeType),
    onTranscript: console_.submit,
    onStopCommand: stopTask,
    onListeningStart: spoken.interrupt,
  });
  const hasRunCommand = (state?.recentActions.length ?? 0) > 0 || run !== null;
  const setupComplete = state?.groq.connection.state === 'connected' && hasRunCommand;
  const showGuide = guideRequested || (!guideDismissed && !setupComplete);
  const dismissGuide = () => {
    setGuideRequested(false);
    setGuideDismissed(true);
  };
  const requestGuide = () => {
    setGuideDismissed(false);
    setGuideRequested(true);
  };

  const switchTab = (tab: TabInfo) => {
    const command = { action: 'tab.switch', target: { tabId: tab.id } } as const;
    console_.runCommand(command, tab.title ? `Switch to ${tab.title}` : describeCommand(command));
  };
  const closeTab = (tab: TabInfo) => {
    const command = { action: 'tab.close', target: { tabId: tab.id } } as const;
    console_.runCommand(command, tab.title ? `Close ${tab.title}` : `Close tab ${tab.position}`);
  };
  const manageInExtension = () => void openExtensionSettings(extensionId).then(() => refresh());

  const connectionPill =
    connection.status === 'checking' ? (
      <StatusPill tone="pending" label="Checking…" />
    ) : connection.status === 'connected' ? (
      <StatusPill tone="ok" label="Extension connected" />
    ) : (
      <StatusPill tone="danger" label="Extension not connected" />
    );

  const visibleOn = (id: Section) => (section === id ? 'flex' : 'hidden lg:flex');

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex items-center gap-6">
          <Brand />
          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            <span aria-current="page" className="rounded-md bg-raised px-2.5 py-1 text-[13px]">
              Console
            </span>
            <button
              type="button"
              onClick={requestGuide}
              className="rounded-md px-2.5 py-1 text-[13px] text-muted transition duration-150 hover:bg-raised hover:text-ink"
            >
              Setup
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {connectionPill}
          {state && (
            <span className="hidden md:inline-flex">
              <StatusPill tone={groqTone(state.groq)} label={groqShortLabel(state.groq)} />
            </span>
          )}
          <IconButton label="Open settings" onClick={() => setSettingsOpen(true)}>
            <Settings aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className={`min-h-0 flex-col ${visibleOn('chat')}`}>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-end gap-4 px-4 py-6">
              {showGuide && (
                <Onboarding
                  connection={connection}
                  hasRunCommand={hasRunCommand}
                  onOpenSettings={manageInExtension}
                  onTryCommand={console_.submit}
                  onDismiss={dismissGuide}
                />
              )}
              <ConversationView
                messages={console_.messages}
                onSwitchTab={switchTab}
                onRetry={console_.submit}
                emptyState={
                  !showGuide ? (
                    <p className="py-8 text-center text-sm text-muted">
                      Nothing yet. Tell Dopilot what to do, or type “help” for exact commands.
                    </p>
                  ) : null
                }
              />
            </div>
          </main>
          <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-4">
            {console_.busy && console_.messages.at(-2)?.text.toLowerCase().startsWith('close') && (
              <p role="status" className="mb-2 text-[13px] text-muted">
                Confirm or decline in the Dopilot window that just opened.
              </p>
            )}
            {run && taskRunning && (
              <div className="mb-2">
                <AgentPanel run={run} onStop={stopTask} />
              </div>
            )}
            <div className="mb-2 empty:hidden">
              <VoiceStatusLine
                voice={voice}
                {...(connected && { onOpenSettings: manageInExtension })}
              />
            </div>
            <CommandComposer
              voiceControls={
                <>
                  <VoiceButton voice={voice} />
                  <SpokenToggle
                    enabled={spoken.enabled}
                    onChange={spoken.setEnabled}
                    available={spoken.available}
                  />
                </>
              }
              value={draft}
              onValueChange={setDraft}
              onSubmit={console_.submit}
              onStop={stopTask}
              canStop={console_.busy || taskRunning}
            />
          </div>
        </div>

        <aside
          aria-label="Browser and activity"
          className={`min-h-0 flex-col gap-3 overflow-y-auto border-line p-4 lg:border-l ${
            section === 'chat' ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <div className={`flex-col gap-3 ${visibleOn('browser')}`}>
            <Panel
              title="Current tab"
              action={
                <IconButton
                  label="New tab"
                  className="size-7"
                  disabled={!connected || console_.busy}
                  onClick={() => console_.runCommand({ action: 'tab.new' }, 'new tab')}
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                </IconButton>
              }
            >
              <CurrentTab
                tab={currentTab}
                emptyLabel={connected ? 'No other tab to act on' : 'Extension not connected'}
                disabled={console_.busy}
                onBack={() => console_.runCommand({ action: 'tab.back' }, 'go back')}
                onForward={() => console_.runCommand({ action: 'tab.forward' }, 'go forward')}
                onReload={() => console_.runCommand({ action: 'tab.reload' }, 'reload')}
              />
              {connected && (
                <p className="mt-2 text-xs text-faint">
                  The last tab you used before this website.
                </p>
              )}
            </Panel>

            <Panel title={state ? `Open tabs (${state.tabs.length})` : 'Open tabs'}>
              {state ? (
                <>
                  <TabList
                    tabs={state.tabs}
                    currentTabId={state.currentTabId}
                    onSwitch={switchTab}
                    onClose={closeTab}
                  />
                  {!state.tabDetailsAvailable && (
                    <p className="mt-2 text-xs leading-relaxed text-faint">
                      Tabs appear by number until you allow tab details in{' '}
                      <button
                        type="button"
                        onClick={manageInExtension}
                        className="underline underline-offset-2 hover:text-ink"
                      >
                        extension settings
                      </button>
                      .
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[13px] text-muted">
                  Connect the extension to see your open tabs.
                </p>
              )}
            </Panel>
          </div>

          <div className={`flex-col gap-3 ${visibleOn('activity')}`}>
            <Panel title="Agent">
              {run ? (
                <div className="flex flex-col gap-2.5">
                  <div>
                    <p className="text-[13px] font-medium">{agentStatusLabel(run.status)}</p>
                    <p className="text-[13px] break-words text-muted">{run.instruction}</p>
                  </div>
                  <AgentTimeline entries={run.timeline} />
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  No task yet. Tell Dopilot what to do, and each step will appear here.
                </p>
              )}
            </Panel>
            <Panel title="Recent actions">
              {state ? (
                <ActionList actions={state.recentActions} />
              ) : (
                <p className="text-[13px] text-muted">
                  Actions will appear here once the extension is connected.
                </p>
              )}
            </Panel>
          </div>
        </aside>
      </div>

      <nav aria-label="Sections" className="flex shrink-0 border-t border-line lg:hidden">
        {SECTIONS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
            className={`flex h-12 flex-1 items-center justify-center gap-1.5 text-xs transition duration-150 ${
              section === id ? 'text-ink' : 'text-faint'
            }`}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <SettingsDrawer
        open={settingsOpen}
        connection={connection}
        onClose={() => setSettingsOpen(false)}
        onOpenExtensionSettings={manageInExtension}
        onShowGuide={() => {
          requestGuide();
          setSettingsOpen(false);
        }}
        onClearConversation={console_.clear}
      />
    </div>
  );
}
