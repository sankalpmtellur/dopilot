export interface ExecutionLimits {
  /** Tools that change something. Reading a page does not count. */
  maxActions: number;
  /** New tabs across a whole task. Separate, so a safe batch is not stopped by `maxActions`. */
  maxBatchActions: number;
  maxDurationMs: number;
  maxConsecutiveFailures: number;
  /** The same call this many times running is treated as a loop. */
  maxIdenticalCalls: number;
  /** The same call this many times among recent calls catches A-B-A-B loops. */
  maxRepeatsInWindow: number;
  /** The same action, even when it keeps working. Scrolling is fine. Forever is not. */
  maxSameAction: number;
  /** Screenshots sent for analysis per task. Each one costs far more than a page read. */
  maxVisionCalls: number;
  /** A hard ceiling on Groq requests, to protect the user's quota. */
  maxModelCalls: number;
  /** Tokens across a task, counted from what Groq reports. */
  maxTaskTokens: number;
  /**
   * How many rate limits in a row to wait out. Per-minute limits are normal on free tiers
   * during longer tasks, so a successful request resets this and the task paces itself.
   */
  maxRateLimitWaits: number;
  /** Rate limits longer than this end the task rather than holding it open. */
  maxRateLimitWaitMs: number;
  /** How many times one run may continue after its service worker was stopped. */
  maxResumes: number;
  /** Failed steps across a whole task, which catches failing in a different way each time. */
  maxTotalFailures: number;
  /** Nobody answering an approval must not hold a task open forever. */
  maxApprovalWaitMs: number;
  /** One Groq request. Longer than this and something is wrong. */
  modelCallTimeoutMs: number;
  /** Choosing a model, which can involve fetching the list. */
  modelChoiceTimeoutMs: number;
  /** Checking one action against the live page. */
  assessTimeoutMs: number;
  /** Running one browser tool. Tools that wait for longer ask for more with `toolTimeoutMs`. */
  toolTimeoutMs: number;
  /** A last resort: no progress at all for this long means the loop itself is stuck. */
  maxStallMs: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxActions: 15,
  maxBatchActions: 20,
  maxDurationMs: 5 * 60 * 1000,
  maxConsecutiveFailures: 3,
  maxIdenticalCalls: 3,
  maxRepeatsInWindow: 4,
  maxSameAction: 10,
  maxVisionCalls: 5,
  maxModelCalls: 30,
  maxTaskTokens: 60_000,
  maxRateLimitWaits: 3,
  maxRateLimitWaitMs: 60_000,
  maxResumes: 5,
  maxTotalFailures: 8,
  maxApprovalWaitMs: 5 * 60 * 1000,
  modelCallTimeoutMs: 45_000,
  modelChoiceTimeoutMs: 15_000,
  assessTimeoutMs: 20_000,
  toolTimeoutMs: 25_000,
  maxStallMs: 2 * 60 * 1000,
};

const RECENT_CALL_WINDOW = 10;

export function recordCallSignature(recent: string[], signature: string): string[] {
  return [...recent, signature].slice(-RECENT_CALL_WINDOW);
}

/** True when this call would repeat what recent calls have already tried. */
export function isRepetitive(
  recent: string[],
  signature: string,
  limits: ExecutionLimits,
): boolean {
  const running = [...recent, signature];
  let identical = 0;
  for (let index = running.length - 1; index >= 0 && running[index] === signature; index -= 1) {
    identical += 1;
  }
  if (identical >= limits.maxIdenticalCalls) return true;
  return running.filter((call) => call === signature).length >= limits.maxRepeatsInWindow;
}

const BACKOFF_CAP_MS = 8000;

/** Exponential, with jitter so a shared outage does not bring every retry back at once. */
export function backoffMs(attempt: number, baseMs: number, random = Math.random): number {
  const delay = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
  return Math.round(delay + delay * 0.2 * random());
}
