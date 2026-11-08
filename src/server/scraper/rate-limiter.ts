export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Sleeps for `ms`, resolving early (without throwing) if `signal` aborts. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Guarantees a minimum gap between the starts of consecutive requests. */
export class RateLimiter {
  private lastStart = 0;

  constructor(
    private delayMs: number,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  setDelay(delayMs: number): void {
    this.delayMs = Math.max(0, delayMs);
  }

  async wait(signal?: AbortSignal): Promise<void> {
    const elapsed = this.now() - this.lastStart;
    const remaining = this.delayMs - elapsed;
    if (this.lastStart !== 0 && remaining > 0) {
      await this.sleep(remaining, signal);
    }
    this.lastStart = this.now();
  }
}
