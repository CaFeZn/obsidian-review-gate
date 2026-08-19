import type { ReviewStatus } from "./review";
import { ReviewError } from "./errors";

const TRANSITIONS: Readonly<Record<ReviewStatus, ReadonlySet<ReviewStatus>>> = {
  pending: new Set(["approved", "rejected", "conflicted", "cancelled"]),
  conflicted: new Set(["pending", "approved", "rejected", "cancelled"]),
  approved: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
};

export function assertTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].has(to)) {
    throw new ReviewError(
      "INVALID_STATE_TRANSITION",
      `Review cannot transition from ${from} to ${to}.`,
      { from, to },
    );
  }
}

export function canTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}
