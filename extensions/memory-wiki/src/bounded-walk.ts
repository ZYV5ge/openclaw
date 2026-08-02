import {
  walkRootDirectory,
  type RootWalkEntry,
  type RootWalkOptions,
} from "openclaw/plugin-sdk/root-walk";

const MEMORY_WIKI_WALK_MAX_DEPTH = 128;
const MEMORY_WIKI_WALK_MAX_ENTRIES = 20_000;

type MemoryWikiWalkLimits = {
  maxDepth?: number;
  maxEntries?: number;
  signal?: RootWalkOptions["signal"];
  entryFilter?: RootWalkOptions["entryFilter"];
  onDirectoryError?: RootWalkOptions["onDirectoryError"];
};

export async function walkMemoryWikiDirectory(
  rootDir: string,
  relativePath: string,
  limits: MemoryWikiWalkLimits = {},
): Promise<RootWalkEntry[]> {
  const entries: RootWalkEntry[] = [];
  try {
    limits.signal?.throwIfAborted();
    for await (const entry of walkRootDirectory(rootDir, relativePath, {
      maxDepth: limits.maxDepth ?? MEMORY_WIKI_WALK_MAX_DEPTH,
      maxEntries: limits.maxEntries ?? MEMORY_WIKI_WALK_MAX_ENTRIES,
      symlinkPolicy: "skip",
      limitBehavior: "throw",
      ...(limits.signal ? { signal: limits.signal } : {}),
      ...(limits.entryFilter ? { entryFilter: limits.entryFilter } : {}),
      ...(limits.onDirectoryError ? { onDirectoryError: limits.onDirectoryError } : {}),
    })) {
      limits.signal?.throwIfAborted();
      entries.push(entry);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "not-file" || code === "not-found") {
      return [];
    }
    throw error;
  }
  return entries;
}
