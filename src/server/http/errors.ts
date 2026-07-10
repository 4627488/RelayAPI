import "server-only";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export interface ErrorLogContext {
  operation?: string;
  request?: Request;
  metadata?: Record<string, unknown>;
}

const loggedErrors = new WeakSet<object>();
const REDACTED = "[REDACTED]";
const SENSITIVE_LOG_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "id_token",
  "openai-api-key",
  "proxy-authorization",
  "refresh_token",
  "set-cookie",
  "set-cookie2",
  "x-api-key",
]);

export function logServerError(
  error: unknown,
  context: ErrorLogContext = {},
) {
  if (error && typeof error === "object") {
    if (loggedErrors.has(error)) {
      return;
    }
    loggedErrors.add(error);
  }

  const operation = context.operation || "request";
  console.error(
    `[RelayAPI][${operation}] error`,
    safeJsonStringify({
      timestamp: new Date().toISOString(),
      operation,
      request: context.request ? requestLogContext(context.request) : undefined,
      metadata: context.metadata
        ? toLogSerializable(context.metadata, new WeakSet())
        : undefined,
      error: errorLogDetail(error, new WeakSet()),
    }),
  );
}

export function errorToResponse(
  error: unknown,
  context: ErrorLogContext = {},
) {
  logServerError(error, context);
  if (isHttpError(error)) {
    const details =
      error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    const retryAfter = Number(details.retry_after || 0);
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...details,
        },
      },
      {
        status: error.status,
        headers:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? { "Retry-After": String(Math.ceil(retryAfter)) }
            : undefined,
      },
    );
  }
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "Internal Server Error",
      },
    },
    { status: 500 },
  );
}

function requestLogContext(request: Request) {
  let path = request.url;
  try {
    const url = new URL(request.url);
    path = `${url.pathname}${url.search}`;
  } catch {
    // Keep the original request URL when it cannot be parsed.
  }
  return {
    method: request.method,
    path,
  };
}

function errorLogDetail(error: unknown, seen: WeakSet<object>) {
  if (error instanceof Error) {
    if (seen.has(error)) {
      return "[Circular]";
    }
    seen.add(error);
    const result: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
    if (isHttpError(error)) {
      result.status = error.status;
      result.code = error.code;
      result.details = toLogSerializable(error.details, seen);
    }
    const withCause = error as Error & { cause?: unknown };
    if (withCause.cause !== undefined) {
      result.cause = toLogSerializable(withCause.cause, seen);
    }
    const ownProperties = errorOwnProperties(error, seen);
    if (Object.keys(ownProperties).length > 0) {
      result.properties = ownProperties;
    }
    return result;
  }
  return toLogSerializable(error, seen);
}

function errorOwnProperties(error: Error, seen: WeakSet<object>) {
  const result: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "cause" ||
      key === "status" ||
      key === "code" ||
      key === "details"
    ) {
      continue;
    }
    result[key] = toLogSerializable(
      (error as unknown as Record<string, unknown>)[key],
      seen,
      key,
    );
  }
  return result;
}

function toLogSerializable(
  value: unknown,
  seen: WeakSet<object>,
  key = "",
): unknown {
  if (isSensitiveLogKey(key)) {
    return REDACTED;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Error) {
    return errorLogDetail(value, seen);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (value instanceof URLSearchParams) {
    return Object.fromEntries(value.entries());
  }
  if (value instanceof Headers) {
    const headers: Record<string, string> = {};
    value.forEach((headerValue, headerKey) => {
      headers[headerKey] = isSensitiveLogKey(headerKey)
        ? REDACTED
        : headerValue;
    });
    return headers;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => toLogSerializable(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = toLogSerializable(entryValue, seen, entryKey);
    }
    return result;
  }
  return String(value);
}

function isSensitiveLogKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    SENSITIVE_LOG_KEYS.has(normalized) ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("secret") ||
    normalized.includes("password")
  );
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
