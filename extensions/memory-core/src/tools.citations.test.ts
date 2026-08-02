// Memory Core tests cover tools.citations plugin behavior.
import fs from "node:fs/promises";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockParams,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import {
  createMemoryCoreTestHarness,
  shortTermTestState as shortTermPromotionTesting,
} from "./test-helpers.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  testing as memoryToolsTesting,
} from "./tools.js";
import {
  asOpenClawConfig,
  createAutoCitationsMemorySearchTool,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function collectWikiResultPaths(results: readonly { corpus: string; path: string }[]): string[] {
  const paths: string[] = [];
  for (const result of results) {
    if (result.corpus === "wiki") {
      paths.push(result.path);
    }
  }
  return paths;
}

type PartialMemorySearchDetails = {
  results: Array<{ corpus: string; path: string }>;
  partial?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  debug?: {
    partialFailures?: Array<{
      phase: "memory" | "supplement";
      kind: "memory-failed" | "memory-cooldown" | "supplement-failed";
      pluginId?: string;
      timedOut?: boolean;
    }>;
  };
};

async function waitFor<T>(task: () => Promise<T>, timeoutMs = 1500): Promise<T> {
  let value: T | undefined;
  await vi.waitFor(
    async () => {
      value = await task();
    },
    { interval: 1, timeout: timeoutMs },
  );
  return value as T;
}

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    backend: "builtin",
    searchImpl: async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "@@ -5,3 @@\nAssistant: noted",
        source: "memory" as const,
      },
    ],
    readFileImpl: async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }),
  });
});

describe("memory search citations", () => {
  function expectFirstMemoryResult<T>(details: { results: T[] }): T {
    expect(details.results).toHaveLength(1);
    const [result] = details.results;
    if (!result) {
      throw new Error("Expected memory search result");
    }
    return result;
  }

  // The first tool call pays Vitest's cold lazy-runtime transform cost on Node 24 CI.
  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(firstResult.citation).toBe("MEMORY.md#L5-L7");
  }, 180_000);

  it("leaves snippet untouched when citations are off", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "off" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
    expect(firstResult.citation).toBeUndefined();
  });

  it("clamps decorated snippets to qmd injected budget", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "abc😀tail",
        source: "memory" as const,
      },
    ]);
    const cfg = asOpenClawConfig({
      memory: { citations: "on", backend: "qmd", qmd: { limits: { maxInjectedChars: 4 } } },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toBe("abc");
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:group:c123");
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("returns unavailable details when memory_search fails (e.g. embeddings 429)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const cfg = createDefaultMemoryToolConfig();
    const tool = createMemorySearchToolOrThrow({ config: cfg });

    const result = await tool.execute("call_1", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("uses default memory manager mode for shared memory_search", async () => {
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
        agents: { list: [{ id: "main", default: true }] },
      }),
    });

    await tool.execute("call_default_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: undefined,
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(0);
  });

  it("uses one-shot CLI memory manager mode for explicit local CLI memory_search", async () => {
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
        agents: { list: [{ id: "main", default: true }] },
      }),
      oneShotCliRun: true,
    });

    await tool.execute("call_cli_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: "cli",
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("returns disabled details when memory_get fails", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md", from: 1, lines: 0 };
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 0,
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 120,
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects fractional memory_get ranges before reading files", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    await expect(
      tool.execute("call_fractional_range", {
        path: "memory/2026-02-19.md",
        from: 1.5,
        lines: 2,
      }),
    ).rejects.toThrow("from must be a positive integer");
    expect(getReadAgentMemoryFileMockCalls()).toBe(0);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("returns truncation metadata and a continuation notice for partial memory_get results", async () => {
    setMemoryBackend("builtin");
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      path: params.relPath,
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: params.from ?? 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    }));

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_partial", { path: "memory/partial.md" });

    expect(result.details).toEqual({
      path: "memory/partial.md",
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    });
  });

  it("persists short-term recall events from memory_search tool hits", async () => {
    const workspaceDir = await createTempWorkspace("memory-tools-recall-");
    try {
      setMemoryBackend("builtin");
      setMemoryWorkspaceDir(workspaceDir);
      setMemorySearchImpl(async () => [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory" as const,
        },
      ]);

      const tool = createMemorySearchToolOrThrow({
        config: asOpenClawConfig({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: true,
                  },
                },
              },
            },
          },
        }),
      });
      await tool.execute("call_recall_persist", { query: "glacier backup" });

      const entries = await waitFor(async () => {
        const store = await shortTermPromotionTesting.readRecallStore(
          workspaceDir,
          new Date().toISOString(),
        );
        const values = Object.values(store.entries);
        expect(values).toHaveLength(1);
        return values;
      });
      const entry = entries[0];
      expect(entry?.path).toBe("memory/2026-04-03.md");
      expect(entry?.recallCount).toBe(1);
      const events = await waitFor(async () => {
        const memoryEvents = await readMemoryHostEvents({ workspaceDir });
        expect(memoryEvents).toHaveLength(1);
        return memoryEvents;
      });
      const event = events[0];
      expect(event?.type).toBe("memory.recall.recorded");
      if (!event || event.type !== "memory.recall.recorded") {
        throw new Error("expected memory recall recorded event");
      }
      expect(event.query).toBe("glacier backup");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("searches registered wiki corpus supplements without calling memory search", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_wiki_only", { query: "alpha", corpus: "wiki" });

    expect(result.details).toStrictEqual({
      results: [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      citations: "auto",
      debug: undefined,
      fallback: undefined,
      mode: undefined,
      model: undefined,
      provider: undefined,
    });
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_search corpus=%s supplements",
    async (corpus) => {
      const search = vi.fn(async () => [
        {
          corpus: "wiki" as const,
          path: "entities/alpha.md",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ]);
      registerMemoryCorpusSupplement("memory-wiki", {
        search,
        get: async () => null,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemorySearchTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_search tool");
      }

      await tool.execute(`call_search_${corpus}`, {
        query: "alpha",
        maxResults: 3,
        corpus,
      });

      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "alpha",
          maxResults: 3,
          agentId: "marketing-agent",
          agentSessionKey: "agent:marketing-agent:main",
          sandboxed: true,
          corpus,
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );

  it("includes memory results in corpus=all even when wiki scores are numerically higher (#77337)", async () => {
    // Wiki uses integer point scores (up to ~100+); memory uses cosine similarity (0-1).
    // Raw-score sort would starve memory hits when maxResults <= number of wiki hits.
    setMemorySearchImpl(async () => [
      {
        path: "memory/note-a.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Memory result A",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 50,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 40,
          snippet: "wiki 2",
        },
        {
          corpus: "wiki",
          path: "w3.md",
          title: "W3",
          kind: "entity",
          score: 30,
          snippet: "wiki 3",
        },
        {
          corpus: "wiki",
          path: "w4.md",
          title: "W4",
          kind: "entity",
          score: 20,
          snippet: "wiki 4",
        },
        {
          corpus: "wiki",
          path: "w5.md",
          title: "W5",
          kind: "entity",
          score: 10,
          snippet: "wiki 5",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_starvation", {
      query: "note",
      corpus: "all",
      maxResults: 5,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };
    const corpora = details.results.map((r) => r.corpus);

    // Memory results must appear despite lower numeric scores, and the spare
    // memory quota should be backfilled by the remaining wiki result.
    expect(corpora).toContain("memory");
    expect(corpora).toContain("wiki");
    expect(details.results).toHaveLength(5);
    expect(collectWikiResultPaths(details.results)).toEqual(["w1.md", "w2.md", "w3.md", "w4.md"]);
  });

  it("preserves memory rank within balanced corpus results", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/z/foo.md",
        startLine: 1,
        endLine: 2,
        score: 1,
        snippet: "exact filename",
        source: "memory" as const,
      },
      {
        path: "memory/a/semantic.md",
        startLine: 1,
        endLine: 2,
        score: 2,
        snippet: "non-exact semantic match",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 10,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 9,
          snippet: "wiki 2",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_ranked_stream", {
      query: "foo.md",
      corpus: "all",
      maxResults: 4,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => entry.path)).toEqual([
      "w1.md",
      "w2.md",
      "memory/z/foo.md",
      "memory/a/semantic.md",
    ]);
  });

  it("merges memory and wiki corpus search results for corpus=all", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 1.1,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_corpus", { query: "alpha", corpus: "all" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(getMemorySearchManagerMockCalls()).toBe(1);
  });

  it("starts supplements before primary memory settles and preserves both lanes", async () => {
    let markPrimaryStarted: (() => void) | undefined;
    const primaryStarted = new Promise<void>((resolve) => {
      markPrimaryStarted = resolve;
    });
    let releasePrimary: (() => void) | undefined;
    const primaryDeferred = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    let supplementStarted = false;
    setMemorySearchImpl(async () => {
      markPrimaryStarted?.();
      await primaryDeferred;
      return [
        {
          path: "MEMORY.md",
          startLine: 5,
          endLine: 7,
          score: 0.9,
          snippet: "primary memory",
          source: "memory" as const,
        },
      ];
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => {
        supplementStarted = true;
        return [
          {
            corpus: "wiki",
            path: "entities/alpha.md",
            score: 4,
            snippet: "wiki result",
          },
        ];
      },
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const resultPromise = tool.execute("call_all_parallel_lanes", {
      query: "alpha",
      corpus: "all",
    });
    await primaryStarted;
    await Promise.resolve();
    const supplementStartedBeforePrimaryRelease = supplementStarted;
    releasePrimary?.();
    const result = await resultPromise;
    const details = result.details as PartialMemorySearchDetails;

    expect(supplementStartedBeforePrimaryRelease).toBe(true);
    expect(details.results.map((entry) => [entry.corpus, entry.path]).toSorted()).toEqual(
      [
        ["memory", "MEMORY.md"],
        ["wiki", "entities/alpha.md"],
      ].toSorted(),
    );
  });

  it("completes corpus=all in the slower lane duration instead of summing both lanes", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchImpl(
        async () =>
          await new Promise((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    path: "MEMORY.md",
                    startLine: 5,
                    endLine: 7,
                    score: 0.9,
                    snippet: "primary memory",
                    source: "memory" as const,
                  },
                ]),
              10_000,
            );
          }),
      );
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () =>
          await new Promise((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    corpus: "wiki",
                    path: "entities/alpha.md",
                    score: 4,
                    snippet: "wiki result",
                  },
                ]),
              9_000,
            );
          }),
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const startedAt = Date.now();
      let settledAt: number | undefined;
      const resultPromise = tool
        .execute("call_all_parallel_duration", { query: "alpha", corpus: "all" })
        .then((result) => {
          settledAt = Date.now();
          return result;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      const settledAtSlowerLane = settledAt;
      if (settledAt === undefined) {
        await vi.advanceTimersByTimeAsync(9_000);
      }
      const result = await resultPromise;
      const details = result.details as PartialMemorySearchDetails;

      expect(settledAtSlowerLane).toBe(startedAt + 10_000);
      expect(details.results).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps primary memory when a wiki supplement times out and does not cooldown memory", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      let supplementSignal: AbortSignal | undefined;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return [
          {
            path: "MEMORY.md",
            startLine: 5,
            endLine: 7,
            score: 0.9,
            snippet: "primary memory",
            source: "memory" as const,
          },
        ];
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async (params) => {
          supplementSignal = params.signal;
          return await new Promise<never>(() => {});
        },
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const resultPromise = tool.execute("call_all_stalled_wiki", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;
      const details = result.details as PartialMemorySearchDetails;

      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["memory", "MEMORY.md"],
      ]);
      expect(details.partial).toBe(true);
      expect(details.disabled).not.toBe(true);
      expect(details.unavailable).not.toBe(true);
      expect(details.debug?.partialFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "supplement",
            kind: "supplement-failed",
            pluginId: "memory-wiki",
            timedOut: true,
          }),
        ]),
      );
      expect(supplementSignal?.aborted).toBe(true);

      const retry = await tool.execute("call_memory_after_stalled_wiki", {
        query: "alpha",
        corpus: "memory",
      });
      expect((retry.details as PartialMemorySearchDetails).results).toHaveLength(1);
      expect(searchCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fulfilled wiki supplement when a sibling times out", async () => {
    vi.useFakeTimers();
    try {
      let stalledSignal: AbortSignal | undefined;
      registerMemoryCorpusSupplement("healthy-wiki", {
        search: async () => [
          {
            corpus: "wiki",
            path: "entities/alpha.md",
            score: 4,
            snippet: "healthy wiki result",
          },
        ],
        get: async () => null,
      });
      registerMemoryCorpusSupplement("stalled-wiki", {
        search: async (params) => {
          stalledSignal = params.signal;
          return await new Promise<never>(() => {});
        },
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const resultPromise = tool.execute("call_wiki_partial_timeout", {
        query: "alpha",
        corpus: "wiki",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;
      const details = result.details as PartialMemorySearchDetails;

      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["wiki", "entities/alpha.md"],
      ]);
      expect(details.partial).toBe(true);
      expect(details.disabled).not.toBe(true);
      expect(details.unavailable).not.toBe(true);
      expect(details.debug?.partialFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "supplement",
            kind: "supplement-failed",
            pluginId: "stalled-wiki",
            timedOut: true,
          }),
        ]),
      );
      expect(stalledSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps wiki results when primary memory times out and cooldowns only primary memory", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return await new Promise<never>(() => {});
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [
          {
            corpus: "wiki",
            path: "entities/alpha.md",
            score: 4,
            snippet: "wiki result",
          },
        ],
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const resultPromise = tool.execute("call_all_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;
      const details = result.details as PartialMemorySearchDetails;

      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["wiki", "entities/alpha.md"],
      ]);
      expect(details.partial).toBe(true);
      expect(details.disabled).not.toBe(true);
      expect(details.unavailable).not.toBe(true);
      expect(details.debug?.partialFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "memory",
            kind: "memory-failed",
            timedOut: true,
          }),
        ]),
      );

      const retry = await tool.execute("call_all_after_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      const retryDetails = retry.details as PartialMemorySearchDetails;
      expect(retryDetails.results).toHaveLength(1);
      expect(retryDetails.partial).toBe(true);
      expect(retryDetails.disabled).not.toBe(true);
      expect(retryDetails.unavailable).not.toBe(true);
      expect(retryDetails.debug?.partialFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "memory",
            kind: "memory-cooldown",
          }),
        ]),
      );
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards caller abort to supplements and preserves the original reason without cooldown", async () => {
    const controller = new AbortController();
    const abortReason = new Error("memory search caller cancelled");
    let searchCalls = 0;
    let supplementSignal: AbortSignal | undefined;
    setMemorySearchImpl(async (options) => {
      searchCalls += 1;
      if (searchCalls > 1) {
        return [
          {
            path: "MEMORY.md",
            startLine: 5,
            endLine: 7,
            score: 0.9,
            snippet: "retry memory",
            source: "memory" as const,
          },
        ];
      }
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async (params) => {
        supplementSignal = params.signal;
        return await new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(params.signal?.reason), {
            once: true,
          });
        });
      },
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const cancelledPromise = tool.execute(
      "call_all_caller_abort",
      { query: "alpha", corpus: "all" },
      controller.signal,
    );
    const supplementStarted = await vi
      .waitFor(() => expect(supplementSignal).toBeInstanceOf(AbortSignal), {
        interval: 1,
        timeout: 1500,
      })
      .then(
        () => true,
        () => false,
      );
    controller.abort(abortReason);

    await expect(cancelledPromise).rejects.toBe(abortReason);
    expect(supplementStarted).toBe(true);
    expect(supplementSignal?.aborted).toBe(true);
    expect(supplementSignal?.reason).toBe(abortReason);

    const retry = await tool.execute("call_memory_after_caller_abort", {
      query: "alpha",
      corpus: "memory",
    });
    expect((retry.details as PartialMemorySearchDetails).results).toHaveLength(1);
    expect(searchCalls).toBe(2);
  });

  it("falls back to a wiki corpus supplement for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_fallback", {
      path: "entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_get corpus=%s supplements",
    async (corpus) => {
      if (corpus === "all") {
        setMemoryReadFileImpl(async () => {
          throw new Error("memory path missing");
        });
      }
      const get = vi.fn(async () => ({
        corpus: "wiki" as const,
        path: "entities/alpha.md",
        content: "Alpha wiki entry",
        fromLine: 2,
        lineCount: 4,
      }));
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [],
        get,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemoryGetTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_get tool");
      }

      await tool.execute(`call_get_${corpus}`, {
        path: "entities/alpha.md",
        from: 2,
        lines: 4,
        corpus,
      });

      expect(get).toHaveBeenCalledWith({
        lookup: "entities/alpha.md",
        fromLine: 2,
        lineCount: 4,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
        corpus,
      });
    },
  );

  it("falls back to a wiki corpus supplement when memory_get corpus=all misses memory without throwing", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "memory/entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry after empty miss",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_miss_fallback", {
      path: "memory/entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry after empty miss",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it("preserves an empty in-file range for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: 0,
    }));
    const getSupplement = vi.fn(async () => ({
      corpus: "wiki" as const,
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      content: "Alpha wiki entry",
      fromLine: 10,
      lineCount: 5,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: getSupplement,
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_range", {
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      text: "",
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 0,
    });
    expect(getSupplement).not.toHaveBeenCalled();
  });

  it("returns the primary error when a corpus=all supplement fallback throws", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("primary read failed");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => {
        throw new Error("supplement lookup failed");
      },
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_supplement_throws", {
      path: "entities/alpha.md",
      corpus: "all",
    });

    expect(result.details).toEqual({
      path: "entities/alpha.md",
      text: "",
      disabled: true,
      error: "primary read failed",
    });
  });
});
