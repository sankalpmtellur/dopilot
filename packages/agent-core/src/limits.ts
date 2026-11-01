export interface ExecutionLimits {
  maxSteps: number;
  maxDurationMs: number;
  /** Stops the loop when the same call repeats this many times in a row. */
  maxIdenticalCalls: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxSteps: 25,
  maxDurationMs: 5 * 60 * 1000,
  maxIdenticalCalls: 3,
};

export type StopReason = 'cancelled' | 'max_steps' | 'max_duration' | 'repeated_call';

/** Decides whether an agent run may take another step. */
export class ExecutionGuard {
  private steps = 0;
  private lastCall: string | undefined;
  private identicalCalls = 0;
  private readonly startedAt: number;

  constructor(
    private readonly signal: AbortSignal,
    private readonly limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Records a planned call and returns why it must not run, if any. */
  check(toolName: string, args: unknown): StopReason | null {
    if (this.signal.aborted) return 'cancelled';
    if (this.now() - this.startedAt >= this.limits.maxDurationMs) return 'max_duration';
    if (this.steps >= this.limits.maxSteps) return 'max_steps';

    const call = JSON.stringify([toolName, args]);
    this.identicalCalls = call === this.lastCall ? this.identicalCalls + 1 : 1;
    this.lastCall = call;
    if (this.identicalCalls >= this.limits.maxIdenticalCalls) return 'repeated_call';

    this.steps += 1;
    return null;
  }
}
