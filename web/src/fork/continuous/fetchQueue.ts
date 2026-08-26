/**
 * fork/continuous — serialised, abortable fetch queue (F12 / F21).
 *
 * The Frigate API on the Pi is a single, starvable worker, and when it stalls the
 * Supervisor watchdog recreates the add-on — a real camera outage, observed twice on
 * 2026-08-26 (handover F12, F21). So:
 *  - heavy endpoints (`/review/activity/motion`, `/recordings/unavailable`) go through a
 *    queue with concurrency 1 — never fan out;
 *  - a job superseded before it starts is dropped, and a running job can be aborted
 *    (AbortController) when the user scrolls past it;
 *  - callers debounce `loadOlder()` so a flick issues one job, not ten.
 * Do not raise the concurrency of the heavy queue "because it is faster on the Mac".
 */
import axios from "axios";

export type Job<T> = {
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  controller: AbortController;
  priority: number;
};

export class FetchQueue {
  private queue: Job<unknown>[] = [];
  private running = new Map<string, Job<unknown>>();
  private inflight = new Set<string>();

  constructor(private concurrency: number) {}

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  enqueue<T>(
    key: string,
    run: (signal: AbortSignal) => Promise<T>,
    priority = 0,
  ): Promise<T> {
    if (this.inflight.has(key)) {
      // already queued or running — return a promise that resolves with the same result
      const existing = [...this.queue, ...this.running.values()].find(
        (j) => j.key === key,
      );
      if (existing) {
        return new Promise<T>((resolve, reject) => {
          const r = existing.resolve;
          const j = existing.reject;
          existing.resolve = (v) => {
            r(v);
            resolve(v as T);
          };
          existing.reject = (e) => {
            j(e);
            reject(e);
          };
        });
      }
    }
    this.inflight.add(key);
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        key,
        run,
        resolve,
        reject,
        controller: new AbortController(),
        priority,
      };
      this.queue.push(job as Job<unknown>);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.pump();
    });
  }

  /** Abort a queued or running job. Queued jobs reject with an AbortError-like error. */
  cancel(key: string) {
    const qi = this.queue.findIndex((j) => j.key === key);
    if (qi !== -1) {
      const [job] = this.queue.splice(qi, 1);
      this.inflight.delete(key);
      job.reject(new DOMException("cancelled", "AbortError"));
      return;
    }
    const running = this.running.get(key);
    if (running) running.controller.abort();
  }

  cancelAll() {
    for (const j of [...this.queue]) this.cancel(j.key);
    for (const j of [...this.running.values()]) j.controller.abort();
  }

  private pump() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running.set(job.key, job);
      job
        .run(job.controller.signal)
        // late-bound on purpose: a duplicate enqueue() wraps job.resolve after the
        // job has already started, and must still be notified
        .then(
          (v) => job.resolve(v),
          (e) => job.reject(e),
        )
        .finally(() => {
          this.running.delete(job.key);
          this.inflight.delete(job.key);
          this.pump();
        });
    }
  }
}

export function isAbort(e: unknown): boolean {
  return (
    axios.isCancel(e) ||
    (e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" &&
      e !== null &&
      (e as { code?: string }).code === "ERR_CANCELED")
  );
}
