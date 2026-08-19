import path from "node:path";
import { normalizeVaultRelativeTarget } from "../path/safe-path";

export interface ReviewLayout {
  readonly root: string;
  readonly pending: string;
  readonly history: string;
  readonly state: string;
  readonly locks: string;
  readonly transactions: string;
  readonly events: string;
  readonly trash: string;
}

export function reviewLayout(vaultRoot: string): ReviewLayout {
  const root = path.join(vaultRoot, ".obsreview");
  return {
    root,
    pending: path.join(root, "pending"),
    history: path.join(root, "history"),
    state: path.join(root, "state"),
    locks: path.join(root, "state", "locks"),
    transactions: path.join(root, "state", "transactions"),
    events: path.join(root, "state", "events"),
    trash: path.join(root, "trash"),
  };
}

export function pendingReviewDirectory(vaultRoot: string, reviewId: string): string {
  return path.join(reviewLayout(vaultRoot).pending, safeReviewId(reviewId));
}

export function historyReviewDirectory(vaultRoot: string, reviewId: string): string {
  return path.join(reviewLayout(vaultRoot).history, safeReviewId(reviewId));
}

export function reviewMetaPath(reviewDirectory: string): string {
  return path.join(reviewDirectory, "meta.json");
}

export function changeDirectory(reviewDirectory: string, changeId: string): string {
  return path.join(reviewDirectory, "changes", safeChangeId(changeId));
}

export function eventPath(vaultRoot: string, reviewId: string): string {
  return path.join(reviewLayout(vaultRoot).events, `${safeReviewId(reviewId)}.json`);
}

export function lockDirectory(vaultRoot: string, reviewId: string): string {
  return path.join(reviewLayout(vaultRoot).locks, `${safeReviewId(reviewId)}.lock`);
}

export function transactionDirectory(vaultRoot: string, transactionId: string): string {
  return path.join(reviewLayout(vaultRoot).transactions, safeOpaqueId(transactionId));
}

export function trashTargetPath(
  vaultRoot: string,
  reviewId: string,
  target: string,
): string {
  const normalized = normalizeVaultRelativeTarget(target);
  return path.join(reviewLayout(vaultRoot).trash, safeReviewId(reviewId), ...normalized.split("/"));
}

export function safeReviewId(value: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)) {
    throw new Error(`Invalid review id: ${value}`);
  }
  return value;
}

export function safeChangeId(value: string): string {
  if (!/^\d{4}$/u.test(value)) throw new Error(`Invalid change id: ${value}`);
  return value;
}

function safeOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9._-]{8,128}$/u.test(value)) {
    throw new Error(`Invalid opaque id: ${value}`);
  }
  return value;
}
