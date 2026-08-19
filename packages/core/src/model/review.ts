/**
 * Persistent domain model for an Obsidian Review Gate review.
 *
 * Core invariants:
 * 1. Pending review cannot mutate the target file.
 * 2. Hunk operations mutate proposal state, not target state.
 * 3. Approve validates base state again immediately before writing.
 * 4. Watchers are advisory; hash verification is authoritative.
 * 5. External agents interact through stable CLI/protocol boundaries.
 * 6. Review state survives Obsidian/plugin/process restart.
 */

export type ReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "conflicted"
  | "cancelled";

export type ReviewOperation = "create" | "modify" | "delete" | "rename";

export interface ReviewSource {
  readonly agent?: string;
  readonly session?: string;
}

export type HunkDecisionKind = "accepted" | "rejected";

export interface HunkDecision {
  readonly decision: HunkDecisionKind;
  readonly at: string;
  readonly baseHash: string;
  readonly proposalHash: string;
}

export interface ReviewConflict {
  readonly detectedAt: string;
  readonly changeIds: readonly string[];
  readonly reason: "base-changed" | "create-target-exists" | "rename-target-exists";
  readonly advisory: boolean;
}

export interface ReviewDecision {
  readonly kind: "approved" | "rejected" | "cancelled";
  readonly at: string;
  readonly actor?: string;
  readonly forced?: boolean;
}

export interface PartialFailure {
  readonly transactionId: string;
  readonly failedAt: string;
  readonly message: string;
  readonly committedChangeIds: readonly string[];
  readonly rollbackErrors: readonly string[];
}

export interface ReviewChange {
  readonly id: string;
  readonly operation: ReviewOperation;
  readonly target: string;
  readonly newTarget?: string;

  /** SHA-256 of the target content captured at submit time. Null for create. */
  readonly baseHash: string | null;
  /** Original target content. Null for create. */
  readonly baseContent: string | null;
  /** Mutable proposed content. Null for delete. */
  readonly proposalContent: string | null;
  /** Hash of the current proposal file, used to reconcile external edits. */
  readonly proposalHash: string | null;

  readonly resultHash?: string | null;
  readonly hunkDecisions: Readonly<Record<string, HunkDecision>>;
}

export interface Review {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: ReviewStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source?: ReviewSource;
  readonly changes: readonly ReviewChange[];
  readonly conflict?: ReviewConflict;
  readonly decision?: ReviewDecision;
  readonly partialFailure?: PartialFailure;
}

export interface StoredReviewChange {
  readonly id: string;
  readonly operation: ReviewOperation;
  readonly target: string;
  readonly newTarget?: string;
  readonly baseHash: string | null;
  readonly baseFile: string | null;
  readonly proposalFile: string | null;
  readonly proposalHash: string | null;
  readonly resultHash?: string | null;
  readonly hunkDecisions: Readonly<Record<string, HunkDecision>>;
}

export interface StoredReview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: ReviewStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source?: ReviewSource;
  readonly changes: readonly StoredReviewChange[];
  readonly conflict?: ReviewConflict;
  readonly decision?: ReviewDecision;
  readonly partialFailure?: PartialFailure;
}

export const TERMINAL_REVIEW_STATUSES = new Set<ReviewStatus>([
  "approved",
  "rejected",
  "cancelled",
]);

export function isTerminalStatus(status: ReviewStatus): boolean {
  return TERMINAL_REVIEW_STATUSES.has(status);
}

export function reviewSummary(review: Review): {
  readonly id: string;
  readonly status: ReviewStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source?: ReviewSource;
  readonly changeCount: number;
  readonly changes: readonly {
    readonly id: string;
    readonly operation: ReviewOperation;
    readonly target: string;
    readonly newTarget?: string;
  }[];
} {
  const changes = review.changes.map((change) => {
    const value: {
      id: string;
      operation: ReviewOperation;
      target: string;
      newTarget?: string;
    } = {
      id: change.id,
      operation: change.operation,
      target: change.target,
    };
    if (change.newTarget !== undefined) value.newTarget = change.newTarget;
    return value;
  });

  const summary: {
    id: string;
    status: ReviewStatus;
    revision: number;
    createdAt: string;
    updatedAt: string;
    source?: ReviewSource;
    changeCount: number;
    changes: typeof changes;
  } = {
    id: review.id,
    status: review.status,
    revision: review.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    changeCount: review.changes.length,
    changes,
  };
  if (review.source !== undefined) summary.source = review.source;
  return summary;
}
