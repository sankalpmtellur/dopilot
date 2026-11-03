import { AgentRunner } from '@dopilot/agent-core';
import type { AgentRun, RunStore } from '@dopilot/agent-core';
import type { ConversationTurn } from '@dopilot/agent-core';
import { chooseToolModel, isAgentActive, MODEL_LIST_TTL_MS } from '@dopilot/shared';
import type { AgentApproval, AgentSource } from '@dopilot/shared';
import { appendActionLog } from '@/lib/action-log';
import {
  loadApiKey,
  loadGroqStatus,
  markKeyRejected,
  recordConnectionTest,
  recordModelIssue,
} from '@/lib/api-key-store';
import { chromeBrowserApi } from '@/lib/browser-commands';
import { chromeContentPort } from '@/lib/content-client';
import { createGroqModelClient } from '@/lib/groq-client';
import { testGroqKey } from '@/lib/groq-test';
import { createMcpBridge } from '@/lib/mcp-bridge';
import { loadPreferences } from '@/lib/preferences';
import { browserImagePort } from '@/lib/screenshot-image';
import { hasAllSitesPermission, isSiteAuthorized } from '@/lib/site-access';
import { createToolService } from '@/lib/tool-service';
import { CaptureAccessError, createVisionService } from '@/lib/vision-service';
import { ALLOWED_WEB_ORIGINS } from '@/messaging/external';
import { hasTabDetails } from '@/permissions/tab-details';

const RUN_KEY = 'agentRun';
const CONVERSATION_KEY = 'agentConversation';
const KEEP_ALIVE_MS = 20_000;
const DOPILOT_TABS_KEY = 'dopilotTabs';
const APPROVAL_WINDOW_KEY = 'approvalWindow';

/** Session storage, so nothing about a task outlives the browser session. */
const store: RunStore = {
  async loadRun() {
    const stored = await chrome.storage.session.get(RUN_KEY);
    return (stored[RUN_KEY] as AgentRun | undefined) ?? null;
  },
  async saveRun(run) {
    await chrome.storage.session.set({ [RUN_KEY]: run });
  },
  async loadConversation() {
    const stored = await chrome.storage.session.get(CONVERSATION_KEY);
    const turns = stored[CONVERSATION_KEY];
    return Array.isArray(turns) ? (turns as ConversationTurn[]) : [];
  },
  async saveConversation(turns) {
    await chrome.storage.session.set({ [CONVERSATION_KEY]: turns });
  },
  async clear() {
    await chrome.storage.session.remove([RUN_KEY, CONVERSATION_KEY]);
  },
};

async function captureTab(windowId: number): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/permission|activeTab|all_urls/i.test(message)) throw new CaptureAccessError();
    throw error;
  }
}

async function modelClient() {
  const apiKey = await loadApiKey();
  if (!apiKey) throw new Error('No API key');
  return createGroqModelClient(apiKey);
}

export const vision = createVisionService({
  api: chromeBrowserApi,
  content: chromeContentPort,
  capture: captureTab,
  image: browserImagePort,
  loadPreferences,
  loadGroqStatus,
  model: modelClient,
});

/**
 * Tabs that have messaged us from Dopilot's website. Without the optional tabs permission
 * their addresses are hidden, so this is how a task knows not to take one over.
 */
const dopilotTabs = new Set<number>();
void chrome.storage.session.get(DOPILOT_TABS_KEY).then((stored) => {
  const known: unknown = stored[DOPILOT_TABS_KEY];
  if (Array.isArray(known)) for (const id of known) dopilotTabs.add(id as number);
});

export function noteDopilotTab(tabId: number | undefined): void {
  if (tabId === undefined || dopilotTabs.has(tabId)) return;
  dopilotTabs.add(tabId);
  void chrome.storage.session.set({ [DOPILOT_TABS_KEY]: [...dopilotTabs] });
}

function isDopilotTab(tabId: number, url: string | undefined): boolean {
  if (url) {
    try {
      return ALLOWED_WEB_ORIGINS.has(new URL(url).origin);
    } catch {
      return false;
    }
  }
  return dopilotTabs.has(tabId);
}

const service = createToolService({
  isDopilotTab,
  isAgentBusy: async () => {
    const run = await agentRunner.view();
    return run !== null && isAgentActive(run.status);
  },
  vision,
  api: chromeBrowserApi,
  content: chromeContentPort,
  permissions: {
    hasTabDetails,
    hasOrigin: isSiteAuthorized,
    hasAllUrls: hasAllSitesPermission,
  },
});

export const mcpBridge = createMcpBridge({ runCall: service.runExternalCall });

/**
 * Picks the model for a request. The list is fetched only when there is none or it is over
 * a day old, and a task never depends on that succeeding: an old list still works.
 */
async function chooseModel(tried: string[]) {
  let status = await loadGroqStatus();
  const age = Date.now() - (status.connection.checkedAt ?? 0);
  if (status.models.length === 0 || age > MODEL_LIST_TTL_MS) {
    const apiKey = await loadApiKey();
    if (!apiKey) return null;
    const outcome = await testGroqKey(apiKey);
    await recordConnectionTest(outcome.connection, outcome.models, outcome.other);
    status = await loadGroqStatus();
  }
  const { modelFallback } = await loadPreferences();
  return chooseToolModel({ status, tried, allowFallback: modelFallback, now: Date.now() });
}

let keepAlive: ReturnType<typeof setInterval> | null = null;

// Service workers sleep after 30 idle seconds. API calls keep this one awake during a task.
function updateKeepAlive(run: AgentRun): void {
  // A screenshot waiting for an answer lives only in this worker, so it has to stay awake.
  const working =
    isAgentActive(run.status) &&
    (run.status !== 'waiting_for_approval' || Boolean(run.approval?.screenshotId));
  if (working && !keepAlive) {
    keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  } else if (!working && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

/** Kept in storage, because the worker may sleep for as long as the user takes to answer. */
async function loadApprovalWindow(): Promise<{ id: number; approvalId: string } | null> {
  const stored = await chrome.storage.session.get(APPROVAL_WINDOW_KEY);
  return (stored[APPROVAL_WINDOW_KEY] as { id: number; approvalId: string } | undefined) ?? null;
}

async function saveApprovalWindow(value: { id: number; approvalId: string } | null): Promise<void> {
  if (value) await chrome.storage.session.set({ [APPROVAL_WINDOW_KEY]: value });
  else await chrome.storage.session.remove(APPROVAL_WINDOW_KEY);
}

async function isSidePanelOpen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as never] });
  return contexts.length > 0;
}

/**
 * Approvals are only ever answered in extension-owned UI, never on the website. The
 * side panel shows them inline. If it is closed, a small window asks instead.
 */
async function presentApproval(approval: AgentApproval | null): Promise<void> {
  const existing = await loadApprovalWindow();
  if (!approval) {
    if (existing) {
      await saveApprovalWindow(null);
      await chrome.windows.remove(existing.id).catch(() => undefined);
    }
    return;
  }
  if (await isSidePanelOpen()) return;
  // Asked again after a restart or on the timer, and one question needs only one window.
  if (existing?.approvalId === approval.id) {
    if (await chrome.windows.get(existing.id).catch(() => null)) return;
  } else if (existing) {
    await chrome.windows.remove(existing.id).catch(() => undefined);
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`confirm/index.html?approval=${encodeURIComponent(approval.id)}`),
    type: 'popup',
    width: 480,
    height: approval.screenshotId ? 520 : 300,
  });
  if (created?.id !== undefined) {
    await saveApprovalWindow({ id: created.id, approvalId: approval.id });
  }
}

const WATCHDOG_ALARM = 'dopilot-watchdog';

/** Timers die with the worker, so an alarm wakes it during a task. Idle, nothing wakes it. */
export function syncWatchdog(active: boolean): void {
  if (active) void chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  else void chrome.alarms.clear(WATCHDOG_ALARM);
}

export function isWatchdog(alarm: chrome.alarms.Alarm): boolean {
  return alarm.name === WATCHDOG_ALARM;
}

let watchdogOn = false;

export const agentRunner = new AgentRunner({
  store,
  budget: async () => {
    const { maxTaskRequests, maxTaskTokens } = await loadPreferences();
    return { maxModelCalls: maxTaskRequests, maxTaskTokens };
  },
  onAction: (action, run) => {
    void appendActionLog({
      id: crypto.randomUUID(),
      at: Date.now(),
      source: run.source,
      ...action,
    }).catch(() => undefined);
  },
  toolbox: service.toolbox,
  chooseModel,
  model: modelClient,
  canUseModel: async () => (await loadApiKey()) !== undefined,
  onChange: (run) => {
    updateKeepAlive(run);
    const active = isAgentActive(run.status);
    if (active !== watchdogOn) {
      watchdogOn = active;
      syncWatchdog(active);
    }
    // Screenshots last no longer than the task that needed them.
    if (!isAgentActive(run.status)) vision.clear();
  },
  onApproval: (approval) => void presentApproval(approval).catch(() => undefined),
  onModelProblem: (kind, model) => {
    if (kind === 'invalid_key' || kind === 'forbidden') void markKeyRejected(kind);
    if (kind === 'model_unavailable' && model) void recordModelIssue(model, 'unavailable');
  },
});

export function startAgentTask(
  instruction: string,
  source: AgentSource,
  protectedTabId: number | null = null,
): Promise<string | null> {
  return agentRunner.start(instruction, source, protectedTabId);
}

/** Closing the approval window counts as declining. */
export async function handleWindowClosed(windowId: number): Promise<void> {
  const existing = await loadApprovalWindow();
  if (existing?.id !== windowId) return;
  await saveApprovalWindow(null);
  await agentRunner.resolveApproval(existing.approvalId, false);
}
