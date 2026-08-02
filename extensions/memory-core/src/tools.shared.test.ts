import type { MemoryCorpusSearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
// Memory Core tests cover corpus supplement aggregation behavior.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it } from "vitest";
import { searchMemoryCorpusSupplements } from "./tools.shared.js";

type SupplementSearchFailure = {
  phase: "supplement";
  kind: "supplement-failed";
  pluginId: string;
};

type SupplementSearchOutcome = {
  status: "complete" | "partial" | "failed" | "aborted";
  results: MemoryCorpusSearchResult[];
  attemptedCount: number;
  fulfilledCount: number;
  failures: SupplementSearchFailure[];
};

function asSupplementSearchOutcome(value: unknown): SupplementSearchOutcome {
  return value as SupplementSearchOutcome;
}

function createWikiResult(path: string): MemoryCorpusSearchResult {
  return {
    corpus: "wiki",
    path,
    score: 4,
    snippet: `Wiki result for ${path}`,
  };
}

beforeEach(() => {
  clearMemoryPluginState();
});

describe("searchMemoryCorpusSupplements", () => {
  it("returns a typed aborted outcome without starting supplements", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled memory supplements"));
    let searchCalls = 0;
    registerMemoryCorpusSupplement("healthy-wiki", {
      search: async () => {
        searchCalls += 1;
        return [];
      },
      get: async () => null,
    });

    const outcome = asSupplementSearchOutcome(
      await searchMemoryCorpusSupplements({
        query: "alpha",
        corpus: "wiki",
        signal: controller.signal,
      }),
    );

    expect(outcome).toMatchObject({
      status: "aborted",
      results: [],
      attemptedCount: 0,
      fulfilledCount: 0,
      failures: [],
    });
    expect(searchCalls).toBe(0);
  });

  it("preserves fulfilled sibling results when another supplement fails", async () => {
    registerMemoryCorpusSupplement("healthy-wiki", {
      search: async () => [createWikiResult("entities/alpha.md")],
      get: async () => null,
    });
    registerMemoryCorpusSupplement("broken-wiki", {
      search: async () => {
        throw new Error("supplement exploded");
      },
      get: async () => null,
    });

    const outcome = asSupplementSearchOutcome(
      await searchMemoryCorpusSupplements({
        query: "alpha",
        corpus: "all",
      }),
    );

    expect(outcome).toMatchObject({
      status: "partial",
      attemptedCount: 2,
      fulfilledCount: 1,
      results: [createWikiResult("entities/alpha.md")],
    });
    expect(outcome.failures).toEqual([
      expect.objectContaining({
        phase: "supplement",
        kind: "supplement-failed",
        pluginId: "broken-wiki",
      }),
    ]);
  });

  it("counts an empty fulfilled supplement as healthy when a sibling fails", async () => {
    registerMemoryCorpusSupplement("healthy-empty", {
      search: async () => [],
      get: async () => null,
    });
    registerMemoryCorpusSupplement("broken-wiki", {
      search: async () => {
        throw new Error("supplement exploded");
      },
      get: async () => null,
    });

    const outcome = asSupplementSearchOutcome(
      await searchMemoryCorpusSupplements({
        query: "nothing",
        corpus: "all",
      }),
    );

    expect(outcome).toMatchObject({
      status: "partial",
      attemptedCount: 2,
      fulfilledCount: 1,
      results: [],
    });
    expect(outcome.failures.map((failure) => failure.pluginId)).toEqual(["broken-wiki"]);
  });

  it("returns a typed failed outcome when every supplement fails", async () => {
    for (const pluginId of ["broken-a", "broken-b"]) {
      registerMemoryCorpusSupplement(pluginId, {
        search: async () => {
          throw new Error(`${pluginId} exploded`);
        },
        get: async () => null,
      });
    }

    const outcome = asSupplementSearchOutcome(
      await searchMemoryCorpusSupplements({
        query: "nothing",
        corpus: "wiki",
      }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      attemptedCount: 2,
      fulfilledCount: 0,
      results: [],
    });
    expect(outcome.failures).toEqual([
      expect.objectContaining({
        phase: "supplement",
        kind: "supplement-failed",
        pluginId: "broken-a",
      }),
      expect.objectContaining({
        phase: "supplement",
        kind: "supplement-failed",
        pluginId: "broken-b",
      }),
    ]);
  });
});
