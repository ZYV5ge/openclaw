/** Shares Codex plugin state across Jiti/Vitest globals in one Node process. */
type ProcessGlobalStore = NodeJS.Process & Record<PropertyKey, unknown>;

function stores(): {
  globalStore: Record<PropertyKey, unknown>;
  processStore: ProcessGlobalStore;
} {
  return {
    globalStore: globalThis as Record<PropertyKey, unknown>,
    processStore: process as ProcessGlobalStore,
  };
}

export function resolveCodexProcessSingleton<T>(key: symbol, create: () => T): T {
  const { globalStore, processStore } = stores();
  const existing = processStore[key] ?? globalStore[key];
  const value = existing === undefined ? create() : (existing as T);
  processStore[key] = value;
  globalStore[key] = value;
  return value;
}

export function readCodexProcessSingleton<T>(key: symbol): T | undefined {
  const { globalStore, processStore } = stores();
  const value = processStore[key] ?? globalStore[key];
  if (value !== undefined) {
    processStore[key] = value;
    globalStore[key] = value;
  }
  return value as T | undefined;
}

export function setCodexProcessSingleton<T>(key: symbol, value: T): T {
  const { globalStore, processStore } = stores();
  processStore[key] = value;
  globalStore[key] = value;
  return value;
}
