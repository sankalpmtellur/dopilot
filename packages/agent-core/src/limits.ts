export interface ExecutionLimits {
  /** Tools that change something. Reading a page does not count. */
  maxActions: number;
  maxDurationMs: number;
  maxConsecutiveFailures: number;
  /** The same call this many times running is treated as a loop. */
  maxIdenticalCalls: number;
  /** The same call this many times among recent calls catches A-B-A-B loops. */
  maxRepeatsInWindow: number;
  /** A hard ceiling on Groq requests, to protect the user's quota. */
  maxModelCalls: number;
  /**
   * How many rate limits in a row to wait out. Per-minute limits are normal on free tiers
   * during longer tasks, so a successful request resets this and the task paces itself.
   */
  maxRateLimitWaits: number;
  /** Rate limits longer than this end the task rather than holding it open. */
  maxRateLimitWaitMs: number;
  /** How many times one run may continue after its service worker was stopped. */
  maxResumes: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxActions: 15,
  maxDurationMs: 5 * 60 * 1000,
  maxConsecutiveFailures: 3,
  maxIdenticalCalls: 3,
  maxRepeatsInWindow: 4,
  maxModelCalls: 30,
  maxRateLimitWaits: 3,
  maxRateLimitWaitMs: 60_000,
  maxResumes: 5,
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
