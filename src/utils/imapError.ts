export class ImapError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = "ImapError";

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ImapError);
    }
  }

  public static fromError(error: Error, context?: string): ImapError {
    const message = context ? `${context}: ${error.message}` : error.message;
    return new ImapError(
      message,
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined,
      error,
    );
  }

  public toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      stack: this.stack,
      originalError: this.originalError
        ? {
            name: this.originalError.name,
            message: this.originalError.message,
            stack: this.originalError.stack,
            ...("code" in this.originalError &&
              typeof this.originalError.code === "string" && {
                code: this.originalError.code,
              }),
          }
        : undefined,
    };
  }
}

export function isImapError(error: unknown): error is ImapError {
  return error instanceof ImapError;
}
