/**
 * Errors carry a stable machine code and an HTTP status. Messages shown to
 * students are produced from the code by the client (i18n), never from raw
 * internal error text, stack traces or provider/model identifiers.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = "resource") => new AppError("not_found", 404, `${what} not found`);
export const forbidden = (why = "forbidden") => new AppError("forbidden", 403, why);
export const unauthorized = (why = "unauthorized") => new AppError("unauthorized", 401, why);
export const badRequest = (code: string, details?: Record<string, unknown>) => new AppError(code, 400, code, details);
export const conflict = (code: string, details?: Record<string, unknown>) => new AppError(code, 409, code, details);
