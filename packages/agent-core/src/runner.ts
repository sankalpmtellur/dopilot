import { describeToolCall, validateToolCall } from '@dopilot/browser-tools';
import type {
  AgentApproval,
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
  trimMessages,
} from './context.js';
import type { ConversationTurn } from './context.js';
import { DEFAULT_EXECUTION_LIMITS, isRepetitive, recordCallSignature } from './limits.js';
import type { ExecutionLimits } from './limits.js';
import { ModelError } from './model.js';
import type { ModelClient, ModelMessage, ModelToolDefinition } from './model.js';

/** Everything needed to continue a run after the service worker has been stopped. */
export interface AgentRun extends AgentRunView {
  messages: ModelMessage[];
  pendingCalls: ToolCall[];
  /** The call being executed, if any. After a restart its outcome is unknown. */
  inflightCallId: string | null;
  recentCalls: string[];
  modelCalls: number;
  consecutiveFailures: number;
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
}

export interface ToolContext {
  /** Set for agent runs, so a choice the user made is remembered for the whole run. */
  runId?: string;
  source: AgentSource;
  currentTabId: number | null;
  protectedTabId?: number | null;
  signal: AbortSignal;
}

export type ToolAssessment =
  | { decision: 'allow' }
  | {
      decision: 'approve';
      kind: AgentApproval['kind'];
      title: string;
      detail: string;
      origin?: string;
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
  chooseModel: (tried: string[]) => Promise<string | null>;
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

const MAX_TIMELINE_ENTRIES = 40;
const MAX_CALLS_PER_RESPONSE = 5;
const MAX_SUMMARY_CHARS = 4000;
const MAX_DETAIL_CHARS = 240;
const RETRY_BACKOFF_MS = 1000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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
    maxActions: run.maxActions,
    timeline: run.timeline,
    approval: run.approval,
    summary: run.summary,
    error: run.error,
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
  private abort: AbortController | null = null;
  private looping: Promise<void> | null = null;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.limits = deps.limits ?? DEFAULT_EXECUTION_LIMITS;
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async view(): Promise<AgentRunView | null> {
    const run = this.current ?? (await this.deps.store.loadRun());
    return run ? toRunView(run) : null;
  }

  /** Starts a task. Returns why it could not start, or null. */
  async start(
    instruction: string,
    source: AgentSource,
    protectedTabId: number | null = null,
  ): Promise<string | null> {
    const existing = this.current ?? (await this.deps.store.loadRun());
    if (existing && isAgentActive(existing.status)) {
      return 'A task is already running. Stop it first.';
    }

    const [{ text, currentTabId }, history] = await Promise.all([
      this.deps.toolbox.describeContext(source, protectedTabId),
      this.deps.store.loadConversation(),
    ]);

    this.current = {
      id: this.createId(),
      instruction,
      source,
      status: 'thinking',
      notice: null,
      model: null,
      startedAt: this.now(),
      finishedAt: null,
      actionCount: 0,
      maxActions: this.limits.maxActions,
      timeline: [],
      approval: null,
      summary: null,
      error: null,
      messages: buildInitialMessages(instruction, history, text),
      pendingCalls: [],
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
    };
    await this.persist();
    this.runLoop();
    return null;
  }

  /** The emergency stop. Takes effect immediately and aborts any Groq request. */
  async stop(): Promise<void> {
    const run = this.current ?? (await this.deps.store.loadRun());
    if (!run || !isAgentActive(run.status)) return;
    this.current = run;
    this.finish(run, 'cancelled', { summary: 'Stopped. No further actions will run.' });
    this.abort?.abort();
    await this.persist();
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const run = this.current ?? (await this.deps.store.loadRun());
    if (!run || run.status !== 'waiting_for_approval' || run.approval?.id !== id) return;
    this.current = run;

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
    }
    run.approvalKey = null;
    await this.persist();
    this.runLoop();
  }

  /**
   * Called when the service worker starts. Continues a run the browser interrupted.
   * A call that was mid-flight is not repeated, since it may already have happened.
   */
  async resume(): Promise<void> {
    if (this.current) return;
    const run = await this.deps.store.loadRun();
    if (!run || !isAgentActive(run.status)) return;
    this.current = run;

    if (run.status === 'waiting_for_approval') return;

    run.resumes += 1;
    if (run.resumes > this.limits.maxResumes) {
      this.finish(run, 'failed', {
        error: 'The browser kept stopping this task, so it was ended for safety.',
      });
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
    }
    run.inflightCallId = null;
    await this.persist();
    this.runLoop();
  }

  /** Forgets the last run and the conversation so far. Does nothing during a task. */
  async reset(): Promise<void> {
    const run = this.current ?? (await this.deps.store.loadRun());
    if (run && isAgentActive(run.status)) return;
    this.current = null;
    await this.deps.store.clear();
  }

  /** Resolves when the loop next goes idle. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.looping;
  }

  private runLoop(): void {
    this.looping ??= this.loop().finally(() => {
      this.looping = null;
    });
  }

  private async loop(): Promise<void> {
    const run = this.current;
    if (!run) return;
    this.abort = new AbortController();

    try {
      while (this.shouldContinue(run)) {
        const limit = this.limitReached(run);
        if (limit) {
          this.finish(run, 'failed', { error: limit });
        } else if (run.pendingCalls.length > 0) {
          await this.processNextCall(run);
        } else {
          await this.think(run);
        }
        await this.persist();
      }
    } catch {
      if (this.shouldContinue(run)) {
        this.finish(run, 'failed', { error: 'Something went wrong, so the task was stopped.' });
        await this.persist();
      }
    } finally {
      this.abort = null;
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
    return null;
  }

  private async think(run: AgentRun): Promise<void> {
    const signal = this.abortSignal();
    run.status = 'thinking';
    await this.persist();

    const modelId = await this.deps.chooseModel(run.triedModels);
    if (!modelId) {
      this.finish(run, 'failed', {
        error: run.triedModels.length
          ? 'None of the available Groq models could run this. Choose another in settings.'
          : 'No Groq model is available. Test your key in settings.',
      });
      return;
    }
    run.model = modelId;
    run.modelCalls += 1;

    let response;
    try {
      const client = await this.deps.model();
      response = await client.complete({
        model: modelId,
        messages: trimMessages(run.messages),
        tools: this.deps.toolbox.definitions,
        signal,
      });
    } catch (error) {
      await this.handleModelError(run, error, modelId);
      return;
    }

    if (!isAgentActive(run.status)) return;
    run.notice = null;
    run.rateLimitWaits = 0;

    if (response.toolCalls.length === 0) {
      const text = response.text?.trim();
      if (text) {
        this.finish(run, 'completed', { summary: text.slice(0, MAX_SUMMARY_CHARS) });
        await this.remember(run, text);
      } else {
        this.countFailure(run, 'The AI returned an empty reply.');
      }
      return;
    }

    const calls = response.toolCalls.slice(0, MAX_CALLS_PER_RESPONSE);
    run.messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: calls });
    run.pendingCalls.push(...calls);
    run.messages = trimMessages(run.messages);
  }

  private async handleModelError(run: AgentRun, error: unknown, modelId: string): Promise<void> {
    if (!isAgentActive(run.status)) return;
    const modelError =
      error instanceof ModelError ? error : new ModelError('server', 'The AI request failed.');

    switch (modelError.kind) {
      case 'cancelled':
        return;

      case 'invalid_key':
      case 'forbidden':
        this.deps.onModelProblem?.(modelError.kind, modelId);
        this.finish(run, 'failed', { error: modelError.message });
        return;

      case 'model_unavailable':
        this.deps.onModelProblem?.(modelError.kind, modelId);
        run.triedModels.push(modelId);
        this.addEntry(run, 'retry', 'done', `Model ${modelId} is unavailable, trying another`);
        return;

      case 'rate_limited': {
        const waitMs = (modelError.retryAfterSeconds ?? 5) * 1000;
        if (
          run.rateLimitWaits >= this.limits.maxRateLimitWaits ||
          waitMs > this.limits.maxRateLimitWaitMs
        ) {
          this.finish(run, 'failed', { error: modelError.message });
          return;
        }
        run.rateLimitWaits += 1;
        // Waiting out a rate limit is not a failed attempt, and costs no quota.
        run.modelCalls -= 1;
        run.notice = `Rate limited by Groq. Retrying in ${Math.ceil(waitMs / 1000)}s.`;
        this.addEntry(run, 'retry', 'done', run.notice);
        await this.persist();
        await this.sleep(waitMs, this.abortSignal());
        return;
      }

      case 'request_too_large':
        this.finish(run, 'failed', { error: modelError.message });
        return;

      default:
        this.addEntry(run, 'retry', 'done', modelError.message);
        this.countFailure(run, modelError.message);
        // A short wait, so a brief network problem does not use up every attempt at once.
        if (isAgentActive(run.status)) {
          await this.persist();
          await this.sleep(RETRY_BACKOFF_MS * run.consecutiveFailures, this.abortSignal());
        }
    }
  }

  private async processNextCall(run: AgentRun): Promise<void> {
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
    const signature = JSON.stringify([tool.name, args]);

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

    if (tool.effect === 'act' && run.actionCount >= this.limits.maxActions) {
      this.finish(run, 'failed', {
        error: `This task reached the limit of ${this.limits.maxActions} actions, so it was stopped.`,
      });
      return;
    }

    const context: ToolContext = {
      runId: run.id,
      source: run.source,
      currentTabId: run.currentTabId,
      protectedTabId: run.protectedTabId,
      signal: this.abortSignal(),
    };

    // Runs again after approval: the page may have changed while the user was deciding.
    const assessment = await this.deps.toolbox.assess(tool.name, args, context);
    if (!isAgentActive(run.status)) return;

    if (assessment.decision === 'block') {
      this.addEntry(run, 'error', 'failed', label, this.resultDetail(assessment.result));
      if (this.endsTask(run, call, assessment.result)) return;
      this.completeCall(run, call, assessment.result, true);
      return;
    }

    if (assessment.decision === 'approve' && assessment.key !== run.approvedKey) {
      this.pauseForApproval(run, assessment);
      return;
    }
    run.approvedKey = null;

    run.status = tool.effect === 'act' ? 'executing' : 'observing';
    const entry = this.addEntry(run, tool.effect === 'act' ? 'act' : 'observe', 'running', label);
    if (tool.effect === 'act') run.actionCount += 1;
    run.inflightCallId = call.id;
    await this.persist();

    let result: ToolResult;
    try {
      result = await this.deps.toolbox.execute(tool.name, args, context);
    } catch {
      result = toolFailure('execution_failed', 'That action could not be completed.');
    }
    run.inflightCallId = null;
    if (!isAgentActive(run.status)) {
      entry.status = 'skipped';
      return;
    }

    entry.status = result.ok ? 'done' : 'failed';
    entry.detail = this.resultDetail(result);
    if (result.ok && result.currentTabId !== undefined) run.currentTabId = result.currentTabId;

    if (this.endsTask(run, call, result)) return;

    this.completeCall(run, call, result, !result.ok && result.recoverable);

    // Later calls in this batch were planned against a page that may no longer exist.
    if (result.ok && result.pageChanged) {
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
    this.finish(run, 'failed', { error: result.message });
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
    };
    run.approval = approval;
    run.approvalKey = assessment.key;
    run.approvalStartedAt = this.now();
    run.status = 'waiting_for_approval';
    run.notice = null;
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
    if (countsAsFailure) {
      this.countFailure(run, result.ok ? '' : result.message);
    } else if (result.ok) {
      run.consecutiveFailures = 0;
    }
  }

  private countFailure(run: AgentRun, message: string): void {
    run.consecutiveFailures += 1;
    if (run.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      this.finish(run, 'failed', {
        error: `Stopped after ${this.limits.maxConsecutiveFailures} failed attempts in a row. Last problem: ${message}`,
      });
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
  ): void {
    run.status = status;
    run.finishedAt = this.now();
    run.notice = null;
    run.summary = outcome.summary ?? null;
    run.error = outcome.error ?? null;
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
      void this.remember(run, outcome.error ?? outcome.summary ?? status);
    }
  }

  private async remember(run: AgentRun, outcome: string): Promise<void> {
    const turns = await this.deps.store.loadConversation();
    await this.deps.store.saveConversation(
      addConversationTurn(turns, { instruction: run.instruction, outcome }),
    );
  }

  private abortSignal(): AbortSignal {
    this.abort ??= new AbortController();
    return this.abort.signal;
  }

  private async persist(): Promise<void> {
    if (!this.current) return;
    await this.deps.store.saveRun(this.current);
    this.deps.onChange?.(this.current);
  }
}
