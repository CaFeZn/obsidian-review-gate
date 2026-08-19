export type ReviewErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_TARGET_PATH"
  | "REVIEW_NOT_FOUND"
  | "CHANGE_NOT_FOUND"
  | "REVIEW_CONFLICT"
  | "REVISION_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "REVIEW_LOCKED"
  | "LOCK_TIMEOUT"
  | "WAIT_TIMEOUT"
  | "CORRUPTED_REVIEW"
  | "APPLY_FAILED"
  | "REBASE_CONFLICT"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export class ReviewError extends Error {
  public readonly code: ReviewErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: ReviewErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asReviewError(error: unknown): ReviewError {
  if (error instanceof ReviewError) return error;
  if (error instanceof Error) {
    return new ReviewError("INTERNAL_ERROR", error.message, undefined, { cause: error });
  }
  return new ReviewError("INTERNAL_ERROR", String(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
