import { describe, expect, it } from "vitest";
import { FetchQueue, isAbort } from "../fetchQueue";

const defer = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};

describe("FetchQueue (F12): never fan out, abort superseded work", () => {
  it("runs at most `concurrency` jobs at once", async () => {
    const q = new FetchQueue(1);
    let running = 0,
      peak = 0;
    const gates = [defer(), defer(), defer()];
    const jobs = gates.map((g, i) =>
      q.enqueue(`j${i}`, async () => {
        running++;
        peak = Math.max(peak, running);
        await g.p;
        running--;
        return i;
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBe(1);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all(jobs)).toEqual([0, 1, 2]);
    expect(peak).toBe(1);
  });
  it("dedupes by key and cancels queued jobs", async () => {
    const q = new FetchQueue(1);
    const g = defer();
    const first = q.enqueue("a", async () => {
      await g.p;
      return "a";
    });
    const dup = q.enqueue("a", async () => "never");
    const later = q.enqueue("b", async () => "b");
    q.cancel("b");
    await expect(later).rejects.toSatisfy(isAbort);
    g.resolve();
    expect(await first).toBe("a");
    expect(await dup).toBe("a");
  });
  it("aborts a running job via its signal", async () => {
    const q = new FetchQueue(1);
    const p = q.enqueue(
      "x",
      (signal) =>
        new Promise((_, rej) =>
          signal.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          ),
        ),
    );
    q.cancel("x");
    await expect(p).rejects.toSatisfy(isAbort);
  });
});
