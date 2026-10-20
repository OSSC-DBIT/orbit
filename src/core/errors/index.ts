import { isHTTPError } from "./http-error.js";

/** Codes are stable identifiers; do not rename without a migration of log consumers. */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "EXTERNAL_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "CONFIG_INVALID"
  | "PENDING_SETUP";

export class OrbitError extends Error {
  readonly code: ErrorCode;
  /** Message that is safe to show to Discord users / API consumers. */
  readonly userMessage: string;
  readonly httpStatus: number;

  constructor(code: ErrorCode, userMessage: string, httpStatus = 500, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = "OrbitError";
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
  }
}

export class ValidationError extends OrbitError {
  constructor(message: string, userMessage = message) {
    super("VALIDATION_FAILED", userMessage, 400);
  }
}

export class UnauthorizedError extends OrbitError {
  constructor(userMessage = "You are not authorized to perform this action.") {
    super("UNAUTHORIZED", userMessage, 401);
  }
}

export class ForbiddenError extends OrbitError {
  constructor(userMessage = "You are not authorized to perform this action.") {
    super("FORBIDDEN", userMessage, 403);
  }
}

export class NotFoundError extends OrbitError {
  constructor(subject = "Resource") {
    super("NOT_FOUND", `${subject} was not found.`, 404);
  }
}

export class ConflictError extends OrbitError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class RateLimitedError extends OrbitError {
  readonly retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number) {
    super("RATE_LIMITED", "Too many requests — please slow down.", 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ExternalServiceError extends OrbitError {
  constructor(service: string, detail?: string, options?: { cause?: unknown }) {
    super(
      "EXTERNAL_UNAVAILABLE",
      `The ${service} service is temporarily unavailable.`,
      502,
      { ...options },
    );
  }
}

export class ConfigurationError extends OrbitError {
  constructor(message: string) {
    super("CONFIG_INVALID", message, 500);
  }
}

export class PendingSetupError extends OrbitError {
  constructor(commandHint: string) {
    super("PENDING_SETUP", commandHint, 409);
  }
}

export function toUserMessage(err: unknown): string {
  if (err instanceof OrbitError) return err.userMessage;
  if (isHTTPError(err)) return "The service returned an unexpected error. Please try again later.";
  // Never leak stack traces or DB internals to users.
  return "Something went wrong handling that request. The error has been logged.";
}

export { isHTTPError } from "./http-error.js";
