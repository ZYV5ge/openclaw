import type { RootWalkEntry, RootWalkOptions } from "openclaw/plugin-sdk/root-walk";
import { describe, expect, it, vi } from "vitest";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";

const rootWalkMocks = vi.hoisted(() => ({
  walkRootDirectory: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/root-walk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/root-walk")>()),
  walkRootDirectory: rootWalkMocks.walkRootDirectory,
}));

describe("walkMemoryWikiDirectory cancellation", () => {
  it("forwards the caller signal to the root walker and stops before a post-abort yield", async () => {
    const controller = new AbortController();
    const abortReason = new Error("memory wiki walk cancelled");
    const yieldedPaths: string[] = [];
    let forwardedSignal: AbortSignal | undefined;
    rootWalkMocks.walkRootDirectory.mockImplementation(async function* (
      _rootDir: string,
      _relativePath: string,
      options: RootWalkOptions,
    ): AsyncGenerator<RootWalkEntry> {
      forwardedSignal = options.signal;
      yieldedPaths.push("first.md");
      yield { relativePath: "first.md", kind: "file", size: 1 };
      controller.abort(abortReason);
      options.signal?.throwIfAborted();
      yieldedPaths.push("second.md");
      yield { relativePath: "second.md", kind: "file", size: 1 };
    });

    const outcome = await walkMemoryWikiDirectory("/vault", "", {
      signal: controller.signal,
    }).then(
      (entries) => ({ status: "fulfilled" as const, entries }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    expect.soft(outcome.status).toBe("rejected");
    expect.soft(outcome.status === "rejected" ? outcome.reason : undefined).toBe(abortReason);
    expect.soft(forwardedSignal).toBe(controller.signal);
    expect(yieldedPaths).toEqual(["first.md"]);
  });
});
