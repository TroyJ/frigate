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

describe("cancelPrefix — retiring a whole page family (B1/D24)", () => {
  it("aborts every QUEUED job under the prefix and leaves the others alone", async () => {
    const q = new FetchQueue(1);
    const started: string[] = [];
    const hold = new Promise<void>(() => {}); // occupies the single slot for ever
    q.enqueue("blocker", () => hold).catch(() => {});
    const a = q.enqueue("old|3|5:100", async () => {
      started.push("a");
      return 1;
    });
    const b = q.enqueue("old|3|5:200", async () => {
      started.push("b");
      return 2;
    });
    const keep = q.enqueue("new|15|30:100", async () => {
      started.push("keep");
      return 3;
    });

    q.cancelPrefix("old|3|5:");

    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    // neither of the cancelled jobs ever ran, and the other family is untouched
    expect(started).toEqual([]);
    expect(q.has("new|15|30:100")).toBe(true);
    void keep;
  });

  it("aborts a RUNNING job under the prefix", async () => {
    const q = new FetchQueue(1);
    let sawAbort = false;
    const running = q.enqueue(
      "old|3|5:100",
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new DOMException("cancelled", "AbortError"));
          });
        }),
    );
    await new Promise((r) => setTimeout(r, 0)); // let it start
    q.cancelPrefix("old|3|5:");
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(sawAbort).toBe(true);
  });

  it("negative control: a prefix that matches nothing cancels nothing", async () => {
    const q = new FetchQueue(1);
    const hold = new Promise<void>(() => {});
    q.enqueue("blocker", () => hold).catch(() => {});
    const survivor = q.enqueue("old|3|5:100", async () => 1);
    q.cancelPrefix("other|9|9:");
    // still queued — the assertion that would fail if cancelPrefix matched too widely
    expect(q.has("old|3|5:100")).toBe(true);
    q.cancelPrefix("old|3|5:");
    await expect(survivor).rejects.toMatchObject({ name: "AbortError" });
  });
});
