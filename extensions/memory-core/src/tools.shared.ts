// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  runMemorySearchWithDeadline,
} from "./memory/search-deadline.js";
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

export type MemoryCorpusSupplementSearchFailure = {
  phase: "supplement";
  kind: "supplement-failed";
  pluginId?: string;
  timedOut: boolean;
  error: string;
};

export type MemoryCorpusSupplementSearchOutcome = {
  status: "complete" | "partial" | "failed" | "aborted";
  results: MemoryCorpusSearchResult[];
  attemptedCount: number;
  fulfilledCount: number;
  failures: MemoryCorpusSupplementSearchFailure[];
};

type SupplementSearchRejection = {
  reason: unknown;
  timedOut: boolean;
};

function emptySupplementSearchOutcome(
  status: "complete" | "aborted" = "complete",
): MemoryCorpusSupplementSearchOutcome {
  return { status, results: [], attemptedCount: 0, fulfilledCount: 0, failures: [] };
}

export const loadMemoryToolRuntime = createLazyRuntimeModule(() => import("./tools.runtime.js"));

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  minScore: optionalFiniteNumberSchema(),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all", "sessions"])),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Integer()),
  lines: Type.Optional(Type.Integer()),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all"])),
});

function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig?.() ?? options.config;
  if (!cfg) {
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
      debug?: NonNullable<MemorySearchManagerResult["debug"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const startedAt = Date.now();
  const { manager, debug, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
    ...(params.acquireLocalService ? { acquireLocalService: params.acquireLocalService } : {}),
  });
  return manager
    ? {
        manager,
        debug: {
          backend: debug?.backend ?? "builtin",
          purpose: debug?.purpose ?? params.purpose ?? "default",
          managerMs: debug?.managerMs ?? Math.max(0, Date.now() - startedAt),
        },
      }
    : { error };
}

export function createMemoryTool(params: {
  options: MemoryToolOptions;
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const latestCtx = resolveMemoryToolContext(params.options) ?? ctx;
      return await params.execute(latestCtx)(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
      : isMissingNodeSqlite
        ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
        : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
      : isMissingNodeSqlite
        ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
        : "Check embedding provider configuration and retry memory_search.");
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
  signal?: AbortSignal;
}): Promise<MemoryCorpusSupplementSearchOutcome> {
  if (params.signal?.aborted) {
    return emptySupplementSearchOutcome("aborted");
  }
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return emptySupplementSearchOutcome();
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return emptySupplementSearchOutcome();
  }

  const searches = supplements.map((registration) => ({
    pluginId: registration.pluginId,
    promise: (async () => {
      let derivedSignal: AbortSignal | undefined;
      try {
        return await runMemorySearchWithDeadline({
          timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
          parentSignal: params.signal,
          run: async (signal) => {
            derivedSignal = signal;
            return await registration.supplement.search({ ...params, signal });
          },
        });
      } catch (reason) {
        throw {
          reason,
          timedOut:
            params.signal?.aborted !== true &&
            derivedSignal?.aborted === true &&
            derivedSignal.reason === reason,
        } satisfies SupplementSearchRejection;
      }
    })(),
  }));
  const settled = await Promise.allSettled(searches.map((search) => search.promise));
  if (params.signal?.aborted) {
    return {
      status: "aborted",
      results: [],
      attemptedCount: searches.length,
      fulfilledCount: settled.filter((entry) => entry.status === "fulfilled").length,
      failures: [],
    };
  }

  const fulfilled = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  const failures: MemoryCorpusSupplementSearchFailure[] = settled.flatMap((entry, index) => {
    if (entry.status === "fulfilled") {
      return [];
    }
    const search = searches[index];
    if (!search) {
      return [];
    }
    const rejection = entry.reason as SupplementSearchRejection;
    return [
      {
        phase: "supplement",
        kind: "supplement-failed",
        pluginId: search.pluginId,
        timedOut: rejection.timedOut,
        error: formatErrorMessage(rejection.reason),
      },
    ];
  });
  const results = fulfilled
    .flat()
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));

  return {
    status: failures.length === 0 ? "complete" : fulfilled.length === 0 ? "failed" : "partial",
    results,
    attemptedCount: searches.length,
    fulfilledCount: fulfilled.length,
    failures,
  };
}

export async function getMemoryCorpusSupplementResult(params: {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}) {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return null;
  }
  for (const registration of listMemoryCorpusSupplements()) {
    const result = await registration.supplement.get(params);
    if (result) {
      return result;
    }
  }
  return null;
}
