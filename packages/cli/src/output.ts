import type { Review, ReviewChange } from "../../core/src/model/review";
import { reviewSummary } from "../../core/src/model/review";
import { ReviewError, asReviewError } from "../../core/src/model/errors";

export const EXIT = {
  success: 0,
  general: 1,
  invalidArguments: 2,
  notFound: 3,
  conflict: 4,
  rejected: 5,
  cancelled: 6,
  timeout: 7,
} as const;

export interface CliFailureDocument {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function reviewDocument(review: Review): Record<string, unknown> {
  return {
    ok: true,
    reviewId: review.id,
    status: review.status,
    revision: review.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...(review.source === undefined ? {} : { source: review.source }),
    changes: review.changes.map(changeDocument),
    ...(review.conflict === undefined ? {} : { conflict: review.conflict }),
    ...(review.decision === undefined ? {} : { decision: review.decision }),
    ...(review.partialFailure === undefined
      ? {}
      : { partialFailure: review.partialFailure }),
  };
}

export function changeDocument(change: ReviewChange): Record<string, unknown> {
  return {
    id: change.id,
    operation: change.operation,
    target: change.target,
    ...(change.newTarget === undefined ? {} : { newTarget: change.newTarget }),
    baseHash: change.baseHash,
    proposalHash: change.proposalHash,
    resultHash: change.resultHash ?? null,
  };
}

export function listDocument(reviews: readonly Review[]): Record<string, unknown> {
  return {
    ok: true,
    count: reviews.length,
    reviews: reviews.map(reviewSummary),
  };
}

export function failureDocument(error: unknown): CliFailureDocument {
  const value = asReviewError(error);
  return {
    ok: false,
    code: value.code,
    message: value.message,
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}

export function exitCodeForError(error: unknown): number {
  if (!(error instanceof ReviewError)) return EXIT.general;
  switch (error.code) {
    case "INVALID_ARGUMENTS":
    case "INVALID_TARGET_PATH":
      return EXIT.invalidArguments;
    case "REVIEW_NOT_FOUND":
    case "CHANGE_NOT_FOUND":
      return EXIT.notFound;
    case "REVIEW_CONFLICT":
    case "REVISION_CONFLICT":
    case "REBASE_CONFLICT":
      return EXIT.conflict;
    case "WAIT_TIMEOUT":
      return EXIT.timeout;
    default:
      return EXIT.general;
  }
}

export function exitCodeForReview(review: Review): number {
  switch (review.status) {
    case "rejected":
      return EXIT.rejected;
    case "cancelled":
      return EXIT.cancelled;
    case "conflicted":
      return EXIT.conflict;
    default:
      return EXIT.success;
  }
}

export function printDocument(document: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}
