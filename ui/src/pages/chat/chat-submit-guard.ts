import type { ChatHost } from "./chat-send-contract.ts";

const MAX_RECENT_SUBMISSIONS = 256;

function pruneRecentSubmissions(
  submissions: NonNullable<ChatHost["chatSubmissionGuards"]>,
  protectedId: string,
): void {
  if (submissions.size <= MAX_RECENT_SUBMISSIONS) {
    return;
  }
  for (const [id, entry] of submissions) {
    if (submissions.size <= MAX_RECENT_SUBMISSIONS) {
      return;
    }
    if (id !== protectedId && entry.settled) {
      submissions.delete(id);
    }
  }
}

export function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  const predecessor = guards.get(key) ?? Promise.resolve();
  const task = predecessor.catch(() => undefined).then(run);
  const tail = task.then(
    () => undefined,
    () => undefined,
  );

  guards.set(key, tail);
  void tail.then(() => {
    if (guards.get(key) === tail) {
      guards.delete(key);
    }
  });
  return task;
}

export async function withChatSubmissionGuard<T>(
  host: ChatHost,
  submissionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const id = submissionId.trim();
  if (!id) {
    throw new Error("Chat submission id is required.");
  }

  const submissions = (host.chatSubmissionGuards ??= new Map());
  const existing = submissions.get(id);
  if (existing) {
    return (await existing.promise) as T;
  }

  const promise = Promise.resolve().then(run);
  const entry = { promise, settled: false };
  submissions.set(id, entry);
  try {
    return await promise;
  } finally {
    entry.settled = true;
    pruneRecentSubmissions(submissions, id);
  }
}
