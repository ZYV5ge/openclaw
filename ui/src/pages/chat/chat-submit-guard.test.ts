// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatHost } from "./chat-send-contract.ts";
import { withChatSubmitGuard } from "./chat-submit-guard.ts";

type GuardWithSubmissionToken = <T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
  submissionToken: string,
) => Promise<T | undefined>;

const guarded = withChatSubmitGuard as unknown as GuardWithSubmissionToken;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHost(): ChatHost {
  return { chatSubmitGuards: new Map<string, Promise<void>>() } as ChatHost;
}

describe("withChatSubmitGuard", () => {
  it("runs three distinct same-key submissions in fair FIFO order", async () => {
    const gate = createDeferred<void>();
    const order: string[] = [];
    const host = createHost();

    const first = guarded(
      host,
      "same-key",
      async () => {
        order.push("first:start");
        await gate.promise;
        order.push("first:end");
      },
      "submission-1",
    );
    const second = guarded(
      host,
      "same-key",
      async () => {
        order.push("second");
      },
      "submission-2",
    );
    const third = guarded(
      host,
      "same-key",
      async () => {
        order.push("third");
      },
      "submission-3",
    );

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("deduplicates reentry by submission token even when the derived key changes", async () => {
    const gate = createDeferred<void>();
    const calls: string[] = [];
    const host = createHost();

    const first = guarded(
      host,
      "original-key",
      async () => {
        calls.push("original");
        await gate.promise;
      },
      "logical-submission",
    );
    await Promise.resolve();
    const reentry = guarded(
      host,
      "changed-key",
      async () => {
        calls.push("reentry");
      },
      "logical-submission",
    );

    gate.resolve();
    await Promise.all([first, reentry]);

    expect(calls).toEqual(["original"]);
  });

  it("continues the same-key FIFO lane after an earlier submission rejects", async () => {
    const gate = createDeferred<void>();
    const order: string[] = [];
    const host = createHost();

    const first = guarded(
      host,
      "same-key",
      async () => {
        order.push("first");
        await gate.promise;
        throw new Error("first failed");
      },
      "submission-1",
    );
    const second = guarded(
      host,
      "same-key",
      async () => {
        order.push("second");
      },
      "submission-2",
    );
    const third = guarded(
      host,
      "same-key",
      async () => {
        order.push("third");
      },
      "submission-3",
    );

    gate.resolve();
    const settled = await Promise.allSettled([first, second, third]);

    expect(settled.map((entry) => entry.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});
