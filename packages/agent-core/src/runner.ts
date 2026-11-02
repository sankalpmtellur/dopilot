import { describeToolCall, validateToolCall } from '@dopilot/browser-tools';
import type {
  AgentApproval,
  AgentFailureKind,
  AgentMetrics,
  AgentRunView,
  AgentSource,
  AgentTimelineEntry,
  ToolCall,
  ToolResult,
} from '@dopilot/shared';
import { isAgentActive, toolFailure } from '@dopilot/shared';
import {
  addConversationTurn,
  buildInitialMessages,
  formatToolResult,
  MALFORMED_CALL_NUDGE,
  trimMessages,
  UNVERIFIED_CLAIM_NUDGE,
} from './context.js';
import type { ConversationTurn } from './context.js';
import {
  backoffMs,
  DEFAULT_EXECUTION_LIMITS,
  isRepetitive,
  recordCallSignature,
} from './limits.js';
import type { ExecutionLimits } from './limits.js';
import { ModelError } from './model.js';
import type { ModelClient, ModelMessage, ModelToolDefinition } from './model.js';

/** Everything needed to continue a run after the service worker has been stopped. */
export interface AgentRun extends AgentRunView {
  metrics: AgentMetrics;
  messages: ModelMessage[];
  pendingCalls: ToolCall[];
  /** The call being executed, if any. After a restart its outcome is unknown. */
  inflightCallId: string | null;
  recentCalls: string[];
  modelCalls: number;
  consecutiveFailures: number;
  visionCalls: number;
  rateLimitWaits: number;
  resumes: number;
  triedModels: string[];
  currentTabId: number | null;
  /** The tab showing Dopilot's website, which a task must never take over. */
  protectedTabId: number | null;
  /** The approval the user has already given for the call at the front of the queue. */
  approvedKey: string | null;
  approvalKey: string | null;
  approvalStartedAt: number | null;
  approvalWaitMs: number;
  /** Bumped by every action that worked, so looking again afterwards is not a repeat. */
  progressEpoch: number;
  totalFailures: number;
  /** Actions in a row that ran but changed nothing. */
  noEffectActions: number;
  /** How hard to cut the conversation, raised when Groq says a request is too large. */
  trimLevel: number;
  /** Corrections already sent to the model, so a stubborn one cannot loop on them. */
  nudges: number;
  toolSuccesses: number;
  lastToolFailed: boolean;
  /** Page data has reached the model, so an address it builds may carry that data. */
  pageDataRead: boolean;
  /** Running a plan that needs no AI. Cleared if the AI has to step in to recover. */
  planned: boolean;
  /** Why the plan stopped, if it did. */
  planFailure: { message: string; recoverable: boolean; kind: AgentFailureKind } | null;
  lastProgressAt: number;
  /** New tabs this task has really created. */
  batchActions: number;
  /** A batch that has started, so Stop and restarts can say how far it really got. */
  liveBatch: { done: number; total: number } | null;
  /** Batches already started. A batch is never run twice, whoever asks. */
  startedBatches: string[];
}

export interface ToolContext {
  /** Set for agent runs, so a choice the user made is remembered for the whole run. */
  runId?: string;
  source: AgentSource;
  currentTabId: number | null;
  protectedTabId?: number | null;
  /** What the user asked for, so an address can be compared with it. */
  instruction?: string;
  pageDataRead?: boolean;
  signal: AbortSignal;
  /** For long tools: how far along they really are. */
  onProgress?: (progress: { done: number; total: number; label: string }) => void;
}

export type ToolAssessment =
  | { decision: 'allow' }
  | {
      decision: 'approve';
      kind: AgentApproval['kind'];
      title: string;
      detail: string;
      origin?: string;
      screenshotId?: string;
      /** Identifies what is being approved, so a changed page needs fresh approval. */
      key: string;
    }
  | { decision: 'block'; result: ToolResult };

/** The browser side of the loop. Implemented by the extension. */
export interface AgentToolbox {
  definitions: ModelToolDefinition[];
  /** Checks permissions and the safety policy against the live page. */
  assess(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolAssessment>;
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /**
   * Tool calls for an instruction simple enough to need no AI, or null. They run through
   * exactly the same checks as calls from a model.
   */
  planSimple?(
    instruction: string,
    source: AgentSource,
    protectedTabId?: number | null,
  ): Promise<{ name: string; arguments: Record<string, unknown> }[] | null>;
  /** How long a call may run, when it legitimately waits for longer than most. */
  toolTimeoutMs?(name: string, args: Record<string, unknown>): number | undefined;
  /** A short description of the current browser state for the first request. */
  describeContext(
    source: AgentSource,
    protectedTabId?: number | null,
  ): Promise<{ text: string; currentTabId: number | null }>;
}

export interface RunStore {
  loadRun(): Promise<AgentRun | null>;
  saveRun(run: AgentRun): Promise<void>;
  loadConversation(): Promise<ConversationTurn[]>;
  saveConversation(turns: ConversationTurn[]): Promise<void>;
  clear(): Promise<void>;
}

export interface AgentRunnerDeps {
  model: () => Promise<ModelClient>;
  /** The model to use, skipping any already tried. Null when none are left. */
  chooseModel: (tried: string[]) => Promise<string | ModelChoice | null>;
  /** Whether the AI can be used at all. Tasks needing no AI run regardless. */
  canUseModel?: () => Promise<boolean>;
  toolbox: AgentToolbox;
  store: RunStore;
  limits?: ExecutionLimits;
  now?: () => number;
  createId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told when an approval starts or ends, so the host can show extension-owned UI. */
  onApproval?: (approval: AgentApproval | null, run: AgentRun) => void;
  onChange?: (run: AgentRun) => void;
  /** Told about key or model problems found while running. */
  onModelProblem?: (kind: ModelError['kind'], model: string | null) => void;
}

/** `notice` tells the user something they would want to know, such as a substitute model. */
export type ModelChoice = { id: string; notice?: string } | { refusal: string };

const MAX_TIMELINE_ENTRIES = 40;
const MAX_CALLS_PER_RESPONSE = 5;
const MAX_SUMMARY_CHARS = 4000;
const MAX_DETAIL_CHARS = 240;
const RETRY_BACKOFF_MS = 1000;
const MAX_TRIM_LEVEL = 2;
const MAX_NUDGES = 2;
const PLAN_TIMEOUT_MS = 3000;
const NO_KEY_MESSAGE = 'Add your Groq API key in Dopilot’s settings first.';

/** A reply saying something was done. Checked against what tools actually reported. */
const CLAIMS_ACTION =
  /\b(opened|navigated|switched|clicked|typed|scrolled|closed|searched|reloaded|submitted|went to|i have (opened|gone|done)|done)\b/i;
const ADMITS_FAILURE =
  /\b(can(no|')t|could ?n[o']t|unable|failed|did ?n[o']t|was ?n[o']t|not|nothing)\b/i;
const LEAKED_CALL = /<\/?function\b|<tool_call>|^\s*\{\s*"(name|tool|function)"\s*:/i;

class StepTimeout extends Error {}
class StepCancelled extends Error {}
const VISUAL_TOOLS = new Set([
  'capture_visible_tab',
  'analyze_screenshot',
  'get_visual_page_context',
  'click_visual_target',
]);
/** Answers built on these may repeat page content, including whatever a screenshot showed. */
const CONTENT_TOOLS = new Set([
  'get_page_content',
  'get_visible_text',
  'analyze_screenshot',
  'get_visual_page_context',
]);

function emptyMetrics(): AgentMetrics {
  return {
    firstStepMs: null,
    totalMs: null,
    modelRequests: 0,
    modelMs: 0,
    toolCalls: 0,
    observeMs: 0,
    actMs: 0,
    visionMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    deterministic: false,
  };
}

/**
 * Runs one step of the loop so that it can never hold the loop open. The result of a step
 * that is abandoned is ignored, whatever it eventually does, and it is told to stop.
 */
function bounded<T>(
  step: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    if (parent.aborted) {
      reject(new StepCancelled());
      return;
    }
    const onAbort = () => {
      cleanup();
      controller.abort();
      reject(new StepCancelled());
    };
    const timer = setTimeout(() => {
      cleanup();
      controller.abort();
      reject(new StepTimeout());
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    };
    parent.addEventListener('abort', onAbort, { once: true });
    step(controller.signal).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error('Step failed'));
      },
    );
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // An abort that already happened will not fire again, so it has to be checked for.
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function toRunView(run: AgentRun): AgentRunView {
  return {
    id: run.id,
    instruction: run.instruction,
    source: run.source,
    status: run.status,
    notice: run.notice,
    model: run.model,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    actionCount: run.actionCount,
    readPageContent: run.readPageContent,
    maxActions: run.maxActions,
    timeline: run.timeline,
    approval: run.approval,
    summary: run.summary,
    error: run.error,
    failureKind: run.failureKind ?? null,
    metrics: run.metrics,
  };
}

/**
 * The agent loop: observe, ask the model, validate, check safety, execute, repeat.
 * Every step is saved before it starts, so the loop is a state machine that can be
 * picked up from storage when a Manifest V3 service worker restarts. While waiting
 * for approval nothing runs at all: the answer re-enters the loop.
 */
export class AgentRunner {
  private readonly limits: ExecutionLimits;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private current: AgentRun | null = null;
  /** The loop driving a run. A cancelled run's stuck loop must not block the next task. */
  private active: { runId: string; abort: AbortController; done: Promise<void> } | null = null;
  private loading: Promise<AgentRun | null> | null = null;
  private starting = false;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.limits = deps.limits ?? DEFAULT_EXECUTION_LIMITS;
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Every entry point shares one copy of the stored run. A worker woken by Stop also runs
   * `resume`, and separate copies would let Stop end one while the other kept acting.
   */
  private load(): Promise<AgentRun | null> {
    if (this.current) return Promise.resolve(this.current);
    this.loading ??= this.deps.store.loadRun().then(
      (run) => {
        this.loading = null;
        this.current ??= run;
        return this.current;
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  async view(): Promise<AgentRunView | null> {
    const run = await this.load();
    return run ? toRunView(run) : null;
  }

  /** Starts a task. Returns why it could not start, or null. */
  async start(
    instruction: string,
    source: AgentSource,
    protectedTabId: number | null = null,
  ): Promise<string | null> {
    // Checked and claimed together, so a double submit cannot start two tasks.
    if (this.starting) return 'A task is already running. Stop it first.';
    this.starting = true;
    try {
      const existing = await this.load();
      if (existing && isAgentActive(existing.status)) {
        return 'A task is already running. Stop it first.';
      }

      const never = new AbortController().signal;
      let setup;
      try {
        setup = await bounded(
          () =>
            Promise.all([
              this.deps.toolbox.describeContext(source, protectedTabId),
              this.deps.store.loadConversation(),
            ]),
          this.limits.assessTimeoutMs,
          never,
        );
      } catch {
        return 'The browser didn’t respond, so the task was not started. Try again.';
      }
      const [{ text, currentTabId }, history] = setup;

      const plan = await bounded(
        async () =>
          (await this.deps.toolbox.planSimple?.(instruction, source, protectedTabId)) ?? null,
        PLAN_TIMEOUT_MS,
        never,
      ).catch(() => null);

      if (!plan && this.deps.canUseModel && !(await this.deps.canUseModel())) {
        return NO_KEY_MESSAGE;
      }

      const startedAt = this.now();
      const calls: ToolCall[] = (plan ?? []).map((call, index) => ({
        id: `plan_${index + 1}`,
        name: call.name,
        arguments: call.arguments,
      }));
      const messages = buildInitialMessages(instruction, history, text);
      if (calls.length > 0)
        messages.push({ role: 'assistant', content: '', toolCalls: [...calls] });

      this.current = {
        id: this.createId(),
        instruction,
        source,
        status: calls.length > 0 ? 'executing' : 'thinking',
        notice: null,
        model: null,
        startedAt,
        finishedAt: null,
        actionCount: 0,
        readPageContent: false,
        visionCalls: 0,
        maxActions: this.limits.maxActions,
        timeline: [],
        approval: null,
        summary: null,
        error: null,
        failureKind: null,
        messages,
        pendingCalls: calls,
        inflightCallId: null,
        recentCalls: [],
        modelCalls: 0,
        consecutiveFailures: 0,
        rateLimitWaits: 0,
        resumes: 0,
        triedModels: [],
        currentTabId,
        protectedTabId,
        approvedKey: null,
        approvalKey: null,
        approvalStartedAt: null,
        approvalWaitMs: 0,
        progressEpoch: 0,
        totalFailures: 0,
        noEffectActions: 0,
        trimLevel: 0,
        nudges: 0,
        toolSuccesses: 0,
        lastToolFailed: false,
        pageDataRead: false,
        planned: calls.length > 0,
        planFailure: null,
        lastProgressAt: startedAt,
        batchActions: 0,
        liveBatch: null,
        startedBatches: [],
        metrics: { ...emptyMetrics(), deterministic: calls.length > 0 },
      };
      await this.persist();
      this.runLoop(this.current);
      return null;
    } finally {
      this.starting = false;
    }
  }

  /** The emergency stop. Takes effect immediately and aborts any Groq request. */
  async stop(): Promise<void> {
    const run = await this.load();
    if (!run || !isAgentActive(run.status)) return;
    this.finish(run, 'cancelled', { summary: this.stoppedSummary(run) });
    this.active?.abort.abort();
    await this.persist();
  }

  /** Says what really happened, so a stopped batch does not leave the count to be guessed. */
  private stoppedSummary(run: AgentRun): string {
    const batch = run.liveBatch;
    return batch
      ? `Stopped after opening ${batch.done} of ${batch.total} tabs. No further actions will run.`
      : 'Stopped. No further actions will run.';
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const run = await this.load();
    if (!run || run.status !== 'waiting_for_approval' || run.approval?.id !== id) return;

    const call = run.pendingCalls[0];
    const entry = run.timeline.findLast((item) => item.kind === 'approval');
    if (entry) entry.status = approved ? 'done' : 'failed';
    if (entry && !approved) entry.detail = 'Declined';

    run.approvalWaitMs += this.now() - (run.approvalStartedAt ?? this.now());
    run.approvalStartedAt = null;
    run.approval = null;
    run.status = 'thinking';
    this.deps.onApproval?.(null, run);

    if (approved) {
      run.approvedKey = run.approvalKey;
    } else if (call) {
      this.pushToolResult(
        run,
        call,
        toolFailure(
          'approval_declined',
          'The user declined this. Do not try another way to do it.',
          false,
        ),
      );
      run.pendingCalls.shift();
      run.lastToolFailed = true;
      if (run.planned) {
        run.planFailure = {
          message: 'You declined, so that was not done.',
          recoverable: false,
          kind: 'declined',
        };
        this.abandonPlan(run, run.planFailure.message, false);
      }
    }
    run.approvalKey = null;
    await this.persist();
    this.runLoop(run);
  }

  /**
   * Called when the service worker starts. Continues a run the browser interrupted.
   * A call that was mid-flight is not repeated, since it may already have happened.
   */
  async resume(): Promise<void> {
    const run = await this.load();
    if (!run || !isAgentActive(run.status) || this.active?.runId === run.id) return;

    if (run.status === 'waiting_for_approval') {
      // The worker may have slept since asking, so the question may need showing again.
      if (run.approval) this.deps.onApproval?.(run.approval, run);
      return;
    }

    run.resumes += 1;
    if (run.resumes > this.limits.maxResumes) {
      this.finish(
        run,
        'failed',
        { error: 'The browser kept stopping this task, so it was ended for safety.' },
        'internal',
      );
      await this.persist();
      return;
    }

    const inflight = run.pendingCalls.find((call) => call.id === run.inflightCallId);
    if (inflight) {
      this.pushToolResult(
        run,
        inflight,
        toolFailure(
          'interrupted',
          'The browser restarted the extension during this action, so its outcome is unknown. Observe the page before continuing, and do not assume it worked.',
        ),
      );
      run.pendingCalls = run.pendingCalls.filter((call) => call.id !== inflight.id);
      const entry = run.timeline.findLast((item) => item.status === 'running');
      if (entry) {
        entry.status = 'failed';
        entry.detail = 'Interrupted by the browser. Outcome unknown.';
      }
      const batch = run.liveBatch;
      run.liveBatch = null;
      // A plan cannot judge an unknown outcome, so whatever remains is not safe to run blind.
      // A batch that was cut short must not be redone either, or its tabs would be doubled.
      if (run.planned) {
        this.abandonPlan(
          run,
          batch
            ? `The browser interrupted this after opening ${batch.done} of ${batch.total} tabs.`
            : 'The browser interrupted that step.',
          !batch,
        );
      }
    }
    run.inflightCallId = null;
    await this.persist();
    this.runLoop(run);
  }

  /**
   * Called on a timer, independent of the loop, so no task can stay open forever: not when
   * nobody answers an approval, not when the worker died mid-step, not when the loop hangs.
   */
  async tick(): Promise<void> {
    const run = await this.load();
    if (!run || !isAgentActive(run.status)) return;
    const now = this.now();

    if (run.status === 'waiting_for_approval') {
      const waited = now - (run.approvalStartedAt ?? now);
      if (waited >= this.limits.maxApprovalWaitMs) {
        this.finish(
          run,
          'failed',
          {
            error: 'Nobody answered the approval, so the task was stopped. Nothing else was done.',
          },
          'declined',
        );
        await this.persist();
      } else if (run.approval) {
        this.deps.onApproval?.(run.approval, run);
      }
      return;
    }

    if (this.active?.runId !== run.id) {
      await this.resume();
      return;
    }
    if (now - run.lastProgressAt >= this.limits.maxStallMs) {
      this.finish(
        run,
        'failed',
        { error: 'This task stopped responding, so it was ended. Check the page before retrying.' },
        'internal',
      );
      this.active.abort.abort();
      await this.persist();
    }
  }

  /** Forgets the last run and the conversation so far. Does nothing during a task. */
  async reset(): Promise<void> {
    const run = await this.load();
    if (run && isAgentActive(run.status)) return;
    this.current = null;
    await this.deps.store.clear();
  }

  /** Resolves when the loop next goes idle. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.active?.done;
  }

  private runLoop(run: AgentRun): void {
    // A loop already driving this run will see the change. Any other is for a run that
    // has ended, and is left to finish on its own so that it cannot hold this one up.
    if (this.active?.runId === run.id) return;
    const abort = new AbortController();
    const entry = { runId: run.id, abort, done: Promise.resolve() };
    this.active = entry;
    entry.done = this.loop(run, abort.signal).finally(() => {
      if (this.active !== entry) return;
      this.active = null;
      // An approval answered just as the loop was leaving must not be lost.
      if (this.current === run && this.shouldContinue(run)) this.runLoop(run);
    });
  }

  private async loop(run: AgentRun, signal: AbortSignal): Promise<void> {
    try {
      while (this.shouldContinue(run)) {
        const limit = this.limitReached(run);
        if (limit) {
          this.finish(run, 'failed', { error: limit }, 'limit');
        } else if (run.pendingCalls.length > 0) {
          await this.processNextCall(run, signal);
        } else if (run.planned) {
          await this.finishPlan(run);
        } else {
          await this.think(run, signal);
        }
        await this.persist();
      }
    } catch {
      if (this.shouldContinue(run)) {
        this.finish(
          run,
          'failed',
          { error: 'Something went wrong, so the task was stopped.' },
          'internal',
        );
      }
      await this.persist().catch(() => undefined);
    }
  }

  private shouldContinue(run: AgentRun): boolean {
    return isAgentActive(run.status) && run.status !== 'waiting_for_approval';
  }

  private limitReached(run: AgentRun): string | null {
    const elapsed = this.now() - run.startedAt - run.approvalWaitMs;
    if (elapsed >= this.limits.maxDurationMs) {
      return 'This task reached the 5 minute limit, so it was stopped.';
    }
    if (run.modelCalls >= this.limits.maxModelCalls) {
      return 'This task used too many AI requests, so it was stopped to protect your quota.';
    }
    if (run.totalFailures >= this.limits.maxTotalFailures) {
      return 'Too many steps of this task failed, so it was stopped. Check the page and try again.';
    }
    return null;
  }

  /** Everything planned has run. Reports it, or hands over to the AI to recover. */
  private async finishPlan(run: AgentRun): Promise<void> {
    const failure = run.planFailure;
    if (!failure) {
      const done = run.timeline.filter((entry) => entry.status === 'done' && entry.detail);
      const text = done.map((entry) => entry.detail).join(' ') || 'Done.';
      this.finish(run, 'completed', { summary: text.slice(0, MAX_SUMMARY_CHARS) });
      await this.remember(run, text);
      return;
    }
    const canRecover =
      failure.recoverable && (this.deps.canUseModel ? await this.deps.canUseModel() : true);
    if (!canRecover) {
      this.finish(run, 'failed', { error: failure.message }, failure.kind);
      return;
    }
    run.planned = false;
    run.planFailure = null;
    run.metrics.deterministic = false;
    this.addEntry(run, 'retry', 'done', 'Asking the AI to work around that');
  }

  private abandonPlan(run: AgentRun, message: string, recoverable = true): void {
    run.planFailure ??= { message, recoverable, kind: recoverable ? 'page' : 'blocked' };
    for (const skipped of run.pendingCalls.splice(0)) {
      this.pushToolResult(
        run,
        skipped,
        toolFailure('skipped', 'Skipped because an earlier step did not work.'),
      );
    }
  }

  private async think(run: AgentRun, signal: AbortSignal): Promise<void> {
    run.status = 'thinking';
    await this.persist();
    if (!isAgentActive(run.status)) return;

    let choice;
    try {
      choice = await bounded(
        () => this.deps.chooseModel(run.triedModels),
        this.limits.modelChoiceTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof StepCancelled) return;
      choice = null;
    }
    const chosen = typeof choice === 'string' ? { id: choice } : choice;
    if (!chosen || 'refusal' in chosen) {
      this.finish(
        run,
        'failed',
        {
          error:
            chosen?.refusal ??
            (run.triedModels.length
              ? 'None of the available Groq models could run this. Choose another in settings.'
              : 'No Groq model is available. Test your key in settings.'),
        },
        'model',
      );
      return;
    }
    const modelId = chosen.id;
    if (chosen.notice && run.model !== modelId) {
      this.addEntry(run, 'retry', 'done', chosen.notice);
    }
    run.model = modelId;
    run.modelCalls += 1;

    const requestStartedAt = this.now();
    let response;
    try {
      response = await bounded(
        async (stepSignal) => {
          const client = await this.deps.model();
          return client.complete({
            model: modelId,
            messages: trimMessages(run.messages, run.trimLevel),
            tools: this.deps.toolbox.definitions,
            signal: stepSignal,
          });
        },
        this.limits.modelCallTimeoutMs,
        signal,
      );
    } catch (error) {
      run.metrics.modelRequests += 1;
      run.metrics.modelMs += this.now() - requestStartedAt;
      if (error instanceof StepCancelled) return;
      await this.handleModelError(
        run,
        error instanceof StepTimeout
          ? new ModelError('timeout', 'Groq took too long to respond.')
          : error,
        modelId,
        signal,
      );
      return;
    }
    run.metrics.modelRequests += 1;
    run.metrics.modelMs += this.now() - requestStartedAt;
    run.metrics.promptTokens += response.usage?.promptTokens ?? 0;
    run.metrics.completionTokens += response.usage?.completionTokens ?? 0;

    if (!isAgentActive(run.status)) return;
    run.notice = null;
    run.rateLimitWaits = 0;

    if (response.toolCalls.length === 0) {
      const text = response.text?.trim();
      if (!text) {
        this.countFailure(run, 'The AI returned an empty reply.');
        return;
      }
      const correction = this.correctionFor(run, text);
      if (correction) {
        run.nudges += 1;
        run.messages.push({ role: 'assistant', content: text.slice(0, MAX_DETAIL_CHARS) });
        run.messages.push({ role: 'user', content: correction });
        return;
      }
      this.finish(run, 'completed', { summary: text.slice(0, MAX_SUMMARY_CHARS) });
      await this.remember(run, text);
      return;
    }

    const calls = response.toolCalls.slice(0, MAX_CALLS_PER_RESPONSE);
    run.messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: calls });
    run.pendingCalls.push(...calls);
    run.messages = trimMessages(run.messages, run.trimLevel);
  }

  /** A final reply is checked against what tools reported before it is believed. */
  private correctionFor(run: AgentRun, text: string): string | null {
    if (run.nudges >= MAX_NUDGES) return null;
    if (LEAKED_CALL.test(text)) return MALFORMED_CALL_NUDGE;
    const claims = CLAIMS_ACTION.test(text) && !ADMITS_FAILURE.test(text);
    if (claims && (run.toolSuccesses === 0 || run.lastToolFailed)) return UNVERIFIED_CLAIM_NUDGE;
    return null;
  }

  private async handleModelError(
    run: AgentRun,
    error: unknown,
    modelId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isAgentActive(run.status)) return;
    const modelError =
      error instanceof ModelError ? error : new ModelError('server', 'The AI request failed.');

    switch (modelError.kind) {
      case 'cancelled':
        return;

      case 'invalid_key':
      case 'forbidden':
        this.deps.onModelProblem?.(modelError.kind, modelId);
        this.finish(run, 'failed', { error: modelError.message }, 'key');
        return;

      case 'model_unavailable':
        this.deps.onModelProblem?.(modelError.kind, modelId);
        run.triedModels.push(modelId);
        this.addEntry(run, 'retry', 'done', `Model ${modelId} is unavailable, trying another`);
        return;

      case 'rate_limited': {
        const waitMs =
          modelError.retryAfterSeconds === undefined
            ? backoffMs(run.rateLimitWaits + 1, 5000)
            : modelError.retryAfterSeconds * 1000;
        if (
          run.rateLimitWaits >= this.limits.maxRateLimitWaits ||
          waitMs > this.limits.maxRateLimitWaitMs
        ) {
          this.finish(run, 'failed', { error: modelError.message }, 'rate_limit');
          return;
        }
        run.rateLimitWaits += 1;
        // Waiting out a rate limit is not a failed attempt, and costs no quota.
        run.modelCalls -= 1;
        run.notice = `Rate limited by Groq. Retrying in ${Math.ceil(waitMs / 1000)}s.`;
        this.addEntry(run, 'retry', 'done', run.notice);
        await this.persist();
        await this.sleep(waitMs, signal);
        return;
      }

      case 'request_too_large':
        // Older page content is what makes a request large, so try again with less of it.
        if (run.trimLevel < MAX_TRIM_LEVEL) {
          run.trimLevel += 1;
          run.modelCalls -= 1;
          this.addEntry(
            run,
            'retry',
            'done',
            'That was too much for the model, retrying with less',
          );
          return;
        }
        this.finish(run, 'failed', { error: modelError.message }, 'model');
        return;

      case 'bad_tool_call':
        run.messages.push({ role: 'user', content: MALFORMED_CALL_NUDGE });
        this.addEntry(run, 'retry', 'done', modelError.message);
        this.countFailure(run, modelError.message, 'model');
        return;

      default: {
        const kind =
          modelError.kind === 'network' || modelError.kind === 'timeout' ? 'network' : 'model';
        this.addEntry(run, 'retry', 'done', modelError.message);
        this.countFailure(run, modelError.message, kind);
        // A short wait, so a brief network problem does not use up every attempt at once.
        if (isAgentActive(run.status)) {
          await this.persist();
          await this.sleep(backoffMs(run.consecutiveFailures, RETRY_BACKOFF_MS), signal);
        }
      }
    }
  }

  private async processNextCall(run: AgentRun, signal: AbortSignal): Promise<void> {
    const call = run.pendingCalls[0];
    if (!call) return;

    const validation = validateToolCall(call.name, call.arguments);
    if (!validation.ok) {
      this.addEntry(run, 'error', 'failed', `Rejected ${call.name}`, validation.error);
      this.completeCall(
        run,
        call,
        toolFailure('invalid_arguments', validation.error),
        /* countsAsFailure */ true,
      );
      return;
    }

    const { tool, args } = validation;
    const label = describeToolCall(tool.name, args);
    // Looking again after something has changed is progress. Repeating an action is not.
    const signature = JSON.stringify([
      tool.name,
      args,
      tool.effect === 'observe' ? run.progressEpoch : 0,
    ]);

    // Skipped once approved, so asking the user does not count as repeating.
    if (!run.approvedKey && isRepetitive(run.recentCalls, signature, this.limits)) {
      this.addEntry(run, 'error', 'failed', label, 'Already tried this. Not repeating it.');
      this.completeCall(
        run,
        call,
        toolFailure(
          'repeated_action',
          'This was already tried and is not being repeated. Try something different, or explain the problem to the user.',
        ),
        true,
      );
      return;
    }
    if (!run.approvedKey) run.recentCalls = recordCallSignature(run.recentCalls, signature);

    if (tool.effect === 'act' && !tool.batchSize && run.actionCount >= this.limits.maxActions) {
      this.finish(
        run,
        'failed',
        {
          error: `This task reached the limit of ${this.limits.maxActions} actions, so it was stopped.`,
        },
        'limit',
      );
      return;
    }

    // Before assessing, because assessing a screenshot already takes one.
    if (tool.cost === 'vision' && run.visionCalls >= this.limits.maxVisionCalls) {
      this.addEntry(run, 'error', 'failed', label, 'Screenshot limit reached for this task.');
      this.completeCall(
        run,
        call,
        toolFailure(
          'vision_limit',
          `This task has used its ${this.limits.maxVisionCalls} screenshots, to protect the user's free quota. Continue with the DOM tools, or explain what you found.`,
          false,
        ),
        false,
      );
      return;
    }

    const contextFor = (stepSignal: AbortSignal): ToolContext => ({
      runId: run.id,
      source: run.source,
      currentTabId: run.currentTabId,
      protectedTabId: run.protectedTabId,
      instruction: run.instruction,
      pageDataRead: run.pageDataRead,
      signal: stepSignal,
    });

    // Runs again after approval: the page may have changed while the user was deciding.
    let assessment: ToolAssessment;
    try {
      assessment = await bounded(
        (stepSignal) => this.deps.toolbox.assess(tool.name, args, contextFor(stepSignal)),
        this.limits.assessTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof StepCancelled) return;
      assessment = {
        decision: 'block',
        result: toolFailure(
          'page_unresponsive',
          'The page did not respond, so nothing was done. It may be busy, or showing a dialog.',
        ),
      };
    }
    if (!isAgentActive(run.status)) return;

    if (assessment.decision === 'block') {
      this.addEntry(run, 'error', 'failed', label, this.resultDetail(assessment.result));
      if (this.endsTask(run, call, assessment.result)) return;
      this.completeCall(run, call, assessment.result, true);
      return;
    }

    if (tool.batchSize) {
      // After the safety check, which explains a single oversized request better.
      const size = tool.batchSize(args);
      const refusal = run.startedBatches.includes(signature)
        ? toolFailure(
            'batch_already_run',
            'This batch was already run in this task, so it was not run again. Report the earlier result.',
            false,
          )
        : run.batchActions + size > this.limits.maxBatchActions
          ? toolFailure(
              'batch_limit',
              `A task can open at most ${this.limits.maxBatchActions} new tabs, and this one has already opened ${run.batchActions}. Nothing more was opened.`,
              false,
            )
          : null;
      if (refusal) {
        this.addEntry(run, 'error', 'failed', label, this.resultDetail(refusal));
        this.completeCall(run, call, refusal, false);
        return;
      }
    }

    if (assessment.decision === 'approve' && assessment.key !== run.approvedKey) {
      this.pauseForApproval(run, assessment);
      return;
    }
    run.approvedKey = null;

    run.status = tool.effect === 'act' ? 'executing' : 'observing';
    const entryKind = VISUAL_TOOLS.has(tool.name)
      ? 'vision'
      : tool.effect === 'act'
        ? 'act'
        : 'observe';
    const entry = this.addEntry(run, entryKind, 'running', label);
    if (tool.cost === 'vision') run.visionCalls += 1;
    if (tool.effect === 'act' && !tool.batchSize) run.actionCount += 1;
    if (tool.batchSize) {
      run.startedBatches.push(signature);
      run.liveBatch = { done: 0, total: tool.batchSize(args) };
    }
    const batchBase = run.batchActions;
    run.inflightCallId = call.id;
    run.metrics.firstStepMs ??= this.now() - run.startedAt;
    await this.persist();
    // Stop may have arrived while saving, and nothing may act after Stop.
    if (!isAgentActive(run.status)) {
      entry.status = 'skipped';
      return;
    }

    const toolStartedAt = this.now();
    let result: ToolResult;
    try {
      result = await bounded(
        (stepSignal) =>
          this.deps.toolbox.execute(tool.name, args, {
            ...contextFor(stepSignal),
            onProgress: ({ done, total, label: progress }) => {
              // Can arrive just after Stop, from a tab that was already on its way.
              if (run.liveBatch) run.liveBatch = { done, total };
              run.batchActions = batchBase + done;
              if (isAgentActive(run.status)) entry.label = progress;
              else if (run.status === 'cancelled') run.summary = this.stoppedSummary(run);
              void this.persist().catch(() => undefined);
            },
          }),
        this.deps.toolbox.toolTimeoutMs?.(tool.name, args) ?? this.limits.toolTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof StepCancelled) {
        entry.status = 'skipped';
        run.inflightCallId = null;
        return;
      }
      result =
        error instanceof StepTimeout
          ? tool.effect === 'act'
            ? toolFailure(
                'outcome_unknown',
                'This did not finish in time, so its outcome is unknown. Look at the page before doing anything else, and do not repeat it blindly.',
              )
            : toolFailure('tool_timeout', 'This took too long, so it was abandoned.')
          : toolFailure('execution_failed', 'That action could not be completed.');
    }
    const elapsed = this.now() - toolStartedAt;
    run.metrics.toolCalls += 1;
    if (tool.cost === 'vision') run.metrics.visionMs += elapsed;
    else if (tool.effect === 'act') run.metrics.actMs += elapsed;
    else run.metrics.observeMs += elapsed;
    run.inflightCallId = null;
    if (!isAgentActive(run.status)) {
      entry.status = 'skipped';
      return;
    }

    if (tool.batchSize) {
      entry.label = label;
      run.liveBatch = null;
    }
    run.batchActions = batchBase + (result.tabsCreated ?? 0);
    entry.status = result.ok ? 'done' : 'failed';
    if (result.ok && CONTENT_TOOLS.has(tool.name)) run.readPageContent = true;
    if (result.ok && result.untrusted && tool.effect === 'observe') run.pageDataRead = true;
    entry.detail = this.resultDetail(result);
    if (result.ok && result.currentTabId !== undefined) run.currentTabId = result.currentTabId;
    run.lastToolFailed = !result.ok;

    if (result.ok) {
      run.toolSuccesses += 1;
      if (tool.effect === 'act') run.progressEpoch += 1;
    }

    if (this.endsTask(run, call, result)) return;

    // An action that keeps changing nothing is a failure, however politely it is reported.
    run.noEffectActions = result.ok && result.noEffect ? run.noEffectActions + 1 : 0;
    const stalled = run.noEffectActions >= this.limits.maxIdenticalCalls;
    this.completeCall(run, call, result, (!result.ok && result.recoverable) || stalled);

    // Later calls in this batch were planned against a page that may no longer exist.
    if (isAgentActive(run.status) && result.ok && result.pageChanged && !run.planned) {
      for (const skipped of run.pendingCalls.splice(0)) {
        this.pushToolResult(
          run,
          skipped,
          toolFailure('skipped', 'Skipped because the page changed. Observe it again first.'),
        );
      }
    }
  }

  /** Some results only the user can get past, such as a CAPTCHA, so the task stops there. */
  private endsTask(run: AgentRun, call: ToolCall, result: ToolResult): boolean {
    if (result.ok || !result.stopTask) return false;
    this.pushToolResult(run, call, result);
    run.pendingCalls.shift();
    this.finish(run, 'failed', { error: result.message }, 'blocked');
    return true;
  }

  private pauseForApproval(
    run: AgentRun,
    assessment: Extract<ToolAssessment, { decision: 'approve' }>,
  ): void {
    const approval: AgentApproval = {
      id: this.createId(),
      kind: assessment.kind,
      title: assessment.title,
      detail: assessment.detail,
      ...(assessment.origin && { origin: assessment.origin }),
      ...(assessment.screenshotId && { screenshotId: assessment.screenshotId }),
    };
    run.approval = approval;
    run.approvalKey = assessment.key;
    run.approvalStartedAt = this.now();
    run.status = 'waiting_for_approval';
    run.notice = null;
    run.metrics.firstStepMs ??= this.now() - run.startedAt;
    this.addEntry(run, 'approval', 'running', assessment.title, assessment.detail);
    this.deps.onApproval?.(approval, run);
  }

  private completeCall(
    run: AgentRun,
    call: ToolCall,
    result: ToolResult,
    countsAsFailure: boolean,
  ): void {
    this.pushToolResult(run, call, result);
    run.pendingCalls.shift();
    // However a planned step failed, including being refused, the rest was planned on it.
    if (run.planned && !result.ok) this.abandonPlan(run, result.message, result.recoverable);
    if (countsAsFailure) {
      this.countFailure(run, result.ok ? '' : result.message);
    } else if (result.ok) {
      run.consecutiveFailures = 0;
    }
  }

  private countFailure(run: AgentRun, message: string, kind: AgentFailureKind = 'page'): void {
    run.consecutiveFailures += 1;
    run.totalFailures += 1;
    if (run.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      this.finish(
        run,
        'failed',
        {
          error: `Stopped after ${this.limits.maxConsecutiveFailures} failed attempts in a row. Last problem: ${message}`,
        },
        kind,
      );
    }
  }

  private pushToolResult(run: AgentRun, call: ToolCall, result: ToolResult): void {
    run.messages.push({ role: 'tool', toolCallId: call.id, content: formatToolResult(result) });
  }

  private resultDetail(result: ToolResult): string {
    return (result.ok ? result.summary : result.message).slice(0, MAX_DETAIL_CHARS);
  }

  private addEntry(
    run: AgentRun,
    kind: AgentTimelineEntry['kind'],
    status: AgentTimelineEntry['status'],
    label: string,
    detail?: string,
  ): AgentTimelineEntry {
    const entry: AgentTimelineEntry = {
      id: this.createId(),
      at: this.now(),
      kind,
      status,
      label,
      ...(detail && { detail: detail.slice(0, MAX_DETAIL_CHARS) }),
    };
    run.timeline.push(entry);
    run.timeline = run.timeline.slice(-MAX_TIMELINE_ENTRIES);
    return entry;
  }

  private finish(
    run: AgentRun,
    status: 'completed' | 'failed' | 'cancelled',
    outcome: { summary?: string; error?: string },
    failureKind: AgentFailureKind | null = null,
  ): void {
    run.status = status;
    run.finishedAt = this.now();
    run.notice = null;
    run.summary = outcome.summary ?? null;
    run.error = outcome.error ?? null;
    run.failureKind = failureKind;
    run.metrics.totalMs = this.now() - run.startedAt - run.approvalWaitMs;
    run.pendingCalls = [];
    run.inflightCallId = null;
    if (run.approval) {
      run.approval = null;
      this.deps.onApproval?.(null, run);
    }
    for (const entry of run.timeline) {
      if (entry.status === 'running') entry.status = 'skipped';
    }
    // The model conversation is only needed while running.
    run.messages = [];
    if (status !== 'completed') {
      void this.remember(run, outcome.error ?? outcome.summary ?? status).catch(() => undefined);
    }
  }

  private async remember(run: AgentRun, outcome: string): Promise<void> {
    const turns = await this.deps.store.loadConversation();
    await this.deps.store.saveConversation(
      addConversationTurn(turns, { instruction: run.instruction, outcome }),
    );
  }

  private async persist(): Promise<void> {
    if (!this.current) return;
    this.current.lastProgressAt = this.now();
    await this.deps.store.saveRun(this.current);
    this.deps.onChange?.(this.current);
  }
}
