import { AgentRunner } from '@dopilot/agent-core';
import type { AgentRun, RunStore } from '@dopilot/agent-core';
import type { ConversationTurn } from '@dopilot/agent-core';
import { isAgentActive, rankToolModels } from '@dopilot/shared';
import type { AgentApproval, AgentSource } from '@dopilot/shared';
import {
  dropSelectedModel,
  loadApiKey,
  loadGroqStatus,
  markKeyRejected,
  recordConnectionTest,
} from '@/lib/api-key-store';
import { chromeBrowserApi } from '@/lib/browser-commands';
import { chromeContentPort } from '@/lib/content-client';
import { createGroqModelClient } from '@/lib/groq-client';
import { testGroqKey } from '@/lib/groq-test';
import { createMcpBridge } from '@/lib/mcp-bridge';
import { createToolService } from '@/lib/tool-service';
import { hasTabDetails } from '@/permissions/tab-details';

const RUN_KEY = 'agentRun';
const CONVERSATION_KEY = 'agentConversation';
const KEEP_ALIVE_MS = 20_000;

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

const service = createToolService({
  api: chromeBrowserApi,
  content: chromeContentPort,
  permissions: {
    hasTabDetails,
    hasOrigin: (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
  },
});

export const mcpBridge = createMcpBridge({ runCall: service.runExternalCall });

/** Picks the user's model, or the best available. Lists models at most once, when needed. */
async function chooseModel(tried: string[]): Promise<string | null> {
  let status = await loadGroqStatus();
  if (status.selectedModel) {
    return tried.includes(status.selectedModel) ? null : status.selectedModel;
  }
  if (status.models.length === 0) {
    const apiKey = await loadApiKey();
    if (!apiKey) return null;
    const outcome = await testGroqKey(apiKey);
    await recordConnectionTest(outcome.connection, outcome.models);
    status = await loadGroqStatus();
  }
  return rankToolModels(status.models).find((model) => !tried.includes(model.id))?.id ?? null;
}

let keepAlive: ReturnType<typeof setInterval> | null = null;

// Service workers sleep after 30 idle seconds. API calls keep this one awake during a task.
function updateKeepAlive(run: AgentRun): void {
  const working = isAgentActive(run.status) && run.status !== 'waiting_for_approval';
  if (working && !keepAlive) {
    keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  } else if (!working && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

let approvalWindow: { id: number; approvalId: string } | null = null;

async function isSidePanelOpen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as never] });
  return contexts.length > 0;
}

/**
 * Approvals are only ever answered in extension-owned UI, never on the website. The
 * side panel shows them inline. If it is closed, a small window asks instead.
 */
async function presentApproval(approval: AgentApproval | null): Promise<void> {
  if (!approval) {
    if (approvalWindow) {
      const { id } = approvalWindow;
      approvalWindow = null;
      await chrome.windows.remove(id).catch(() => undefined);
    }
    return;
  }
  if (await isSidePanelOpen()) return;
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`confirm/index.html?approval=${encodeURIComponent(approval.id)}`),
    type: 'popup',
    width: 440,
    height: 280,
  });
  if (created?.id !== undefined) approvalWindow = { id: created.id, approvalId: approval.id };
}

export const agentRunner = new AgentRunner({
  store,
  toolbox: service.toolbox,
  chooseModel,
  model: async () => {
    const apiKey = await loadApiKey();
    if (!apiKey) throw new Error('No API key');
    return createGroqModelClient(apiKey);
  },
  onChange: updateKeepAlive,
  onApproval: (approval) => void presentApproval(approval).catch(() => undefined),
  onModelProblem: (kind, model) => {
    if (kind === 'invalid_key' || kind === 'forbidden') void markKeyRejected(kind);
    if (kind === 'model_unavailable' && model) void dropSelectedModel(model);
  },
});

export async function startAgentTask(
  instruction: string,
  source: AgentSource,
  protectedTabId: number | null = null,
): Promise<string | null> {
  if (!(await loadApiKey())) return 'Add your Groq API key in Dopilot’s settings first.';
  return agentRunner.start(instruction, source, protectedTabId);
}

/** Closing the approval window counts as declining. */
export function handleWindowClosed(windowId: number): void {
  if (approvalWindow?.id !== windowId) return;
  const { approvalId } = approvalWindow;
  approvalWindow = null;
  void agentRunner.resolveApproval(approvalId, false);
}
