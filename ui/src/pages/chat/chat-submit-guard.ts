import type { ChatHost } from "./chat-send-contract.ts";

const MAX_RECENT_SUBMISSIONS = 256;

type SubmissionGuardEntry = {
  promise: Promise<unknown>;
  settled: boolean;
};

function pruneSettledSubmissionGuards(
  guards: Map<string, SubmissionGuardEntry>,
): void {
  let excess = guards.size - MAX_RECENT_SUBMISSIONS;
  if (excess <= 0) {
    return;
  }
  for (const [key, entry] of guards) {
    if (!entry.settled) {
      continue;
    }
    guards.delete(key);
    excess -= 1;
    if (excess <= 0) {
      return;
    }
  }
}

export async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<unknown>>());
  const existing = guards.get(key);
  if (existing) {
    return (await existing) as T;
  }
  let resolveGuard!: (value: T | PromiseLike<T>) => void;
  let rejectGuard!: (reason?: unknown) => void;
  const guard = new Promise<T>((resolve, reject) => {
    resolveGuard = resolve;
    rejectGuard = reject;
  });
  void guard.catch(() => undefined);
  guards.set(key, guard);
  try {
    const result = await run();
    resolveGuard(result);
    return result;
  } catch (error) {
    rejectGuard(error);
    throw error;
  } finally {
    if (guards.get(key) === guard) {
      guards.delete(key);
    }
  }
}

export async function withChatSubmissionGuard<T>(
  host: ChatHost,
  submissionId: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmissionGuards ??= new Map<
    string,
    SubmissionGuardEntry
  >());
  const existing = guards.get(submissionId);
  if (existing) {
    return (await existing.promise) as T;
  }
  let resolveGuard!: (value: T | PromiseLike<T>) => void;
  let rejectGuard!: (reason?: unknown) => void;
  const guard = new Promise<T>((resolve, reject) => {
    resolveGuard = resolve;
    rejectGuard = reject;
  });
  void guard.catch(() => undefined);
  const entry: SubmissionGuardEntry = {
    promise: guard,
    settled: false,
  };
  guards.set(submissionId, entry);
  try {
    const result = await run();
    resolveGuard(result);
    return result;
  } catch (error) {
    rejectGuard(error);
    throw error;
  } finally {
    entry.settled = true;
    pruneSettledSubmissionGuards(guards);
  }
}
