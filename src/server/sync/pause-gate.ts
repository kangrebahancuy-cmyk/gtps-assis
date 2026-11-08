import type { RunControl } from "@/server/scraper/crawler";

/**
 * Pause/resume switch for one run. A paused crawler stops before its next
 * page (the request already in flight finishes first). Cancelling releases it.
 */
export class PauseGate implements RunControl {
  private paused = false;
  private waiters: Array<() => void> = [];

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
}
