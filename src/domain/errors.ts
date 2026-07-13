export type ReviewerErrorCode =
  | "AUTH_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "CANCELLED"
  | "COMMAND_FAILED"
  | "CONFIGURATION_ERROR"
  | "CONTENT_LIMIT_EXCEEDED"
  | "FEATURE_CONFLICT"
  | "FEATURE_NOT_FOUND"
  | "FEATURE_NOT_UNIQUE"
  | "INVALID_EVIDENCE"
  | "INVALID_INPUT"
  | "PATH_OUTSIDE_ROOT"
  | "PROVIDER_NOT_DETECTED"
  | "REPOSITORY_NOT_FOUND"
  | "STALE_HEAD"
  | "TIMEOUT"
  | "UNEXPECTED_ERROR";

export class ReviewerError extends Error {
  readonly code: ReviewerErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ReviewerErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ReviewerError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function toReviewerError(error: unknown): ReviewerError {
  if (error instanceof ReviewerError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ReviewerError("CANCELLED", "The operation was cancelled.");
  }
  if (error instanceof Error) {
    return new ReviewerError("UNEXPECTED_ERROR", error.message);
  }
  return new ReviewerError("UNEXPECTED_ERROR", "An unknown error occurred.");
}
