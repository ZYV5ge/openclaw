import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";

function sameComposerAttachments(
  current: readonly ChatAttachment[],
  snapshot: readonly ChatAttachment[],
): boolean {
  return (
    current.length === snapshot.length &&
    current.every((attachment, index) => {
      const expected = snapshot[index];
      return (
        expected !== undefined &&
        attachment.id === expected.id &&
        attachment.mimeType === expected.mimeType &&
        attachment.fileName === expected.fileName &&
        attachment.sizeBytes === expected.sizeBytes
      );
    })
  );
}

export function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: PendingComposerSnapshot,
) {
  const restorePlan = pendingComposerRestorePlan(host, opts);
  if (restorePlan.willRestoreDraft) {
    host.chatMessage = opts.previousDraft ?? "";
  }
  if (restorePlan.willRestoreAttachments) {
    host.chatAttachments = opts.previousAttachments ?? [];
  }
  if (restorePlan.complete && restorePlan.hasSnapshot) {
    opts.releaseForRetry?.();
  }
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  releaseForRetry?: () => void;
};

export function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const hasDraftSnapshot = snapshot.previousDraft !== undefined;
  const hasAttachmentSnapshot = snapshot.previousAttachments !== undefined;
  const draftAlreadyRestored =
    hasDraftSnapshot && host.chatMessage === (snapshot.previousDraft ?? "");
  const willRestoreDraft =
    hasDraftSnapshot && !draftAlreadyRestored && !host.chatMessage.trim();
  const attachmentsAlreadyRestored =
    hasAttachmentSnapshot &&
    sameComposerAttachments(host.chatAttachments, snapshot.previousAttachments ?? []);
  const willRestoreAttachments = Boolean(
    hasAttachmentSnapshot &&
    !attachmentsAlreadyRestored &&
    snapshot.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (draftAlreadyRestored || willRestoreDraft || !host.chatMessage.trim()),
  );
  return {
    complete:
      (!hasDraftSnapshot || draftAlreadyRestored || willRestoreDraft) &&
      (!hasAttachmentSnapshot || attachmentsAlreadyRestored || willRestoreAttachments),
    hasSnapshot: hasDraftSnapshot || hasAttachmentSnapshot,
    willRestoreAttachments,
    willRestoreDraft,
  };
}

export function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: PendingComposerSnapshot & {
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const restorePlan = pendingComposerRestorePlan(host, opts);
  const willRestoreDraft = restoreComposer && restorePlan.willRestoreDraft;
  const willRestoreAttachments = restoreComposer && restorePlan.willRestoreAttachments;
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
    if (restorePlan.complete && restorePlan.hasSnapshot) {
      opts.releaseForRetry?.();
    }
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}
