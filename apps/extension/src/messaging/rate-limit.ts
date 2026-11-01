/** A fixed-window limit, so a misbehaving page cannot flood the browser with tabs. */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    const time = this.now();
    if (time - this.windowStart >= this.windowMs) {
      this.windowStart = time;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}
