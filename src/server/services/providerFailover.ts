import "server-only";

const RETRYABLE_PROVIDER_STATUS_CODES = new Set([
  401,
  403,
  429,
  500,
  502,
  503,
  504,
]);

export const DEFAULT_PROVIDER_FAILOVER_ATTEMPTS = 3;

export function isRetryableProviderStatus(statusCode: number) {
  return RETRYABLE_PROVIDER_STATUS_CODES.has(statusCode);
}

export function providerRetryAfterMs(
  headers: Pick<Headers, "get">,
  nowMs = Date.now(),
) {
  const retryAfter = headers.get("retry-after")?.trim() || "";
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  }
  for (const key of ["x-ratelimit-reset", "x-rate-limit-reset"]) {
    const value = Number(headers.get(key));
    if (!Number.isFinite(value) || value <= 0) continue;
    const resetMs = value > 10_000_000_000 ? value : value * 1000;
    return Math.max(0, resetMs - nowMs);
  }
  return null;
}

export function providerUpstreamError(
  bodyText: string,
  fallbackMessage: string,
) {
  const body = parseJson(bodyText);
  const error = isRecord(body) ? body.error : null;
  const code =
    stringValue(isRecord(error) ? error.code : null) ||
    stringValue(isRecord(error) ? error.type : null) ||
    stringValue(isRecord(body) ? body.code : null) ||
    stringValue(isRecord(body) ? body.type : null) ||
    "upstream_error";
  const message =
    stringValue(isRecord(error) ? error.message : null) ||
    stringValue(typeof error === "string" ? error : null) ||
    stringValue(isRecord(body) ? body.message : null) ||
    bodyText.trim() ||
    fallbackMessage;
  return { code, message };
}

export function providerThrownError(error: unknown, fallbackStatus = 502) {
  const record = isRecord(error) ? error : null;
  const embedded = record && isRecord(record.codexErrorInfo)
    ? record.codexErrorInfo
    : null;
  const details = record?.details;
  const parsed = providerUpstreamError(
    stringify(details),
    error instanceof Error ? error.message : String(error),
  );
  return {
    statusCode: positiveNumber(embedded?.statusCode) || fallbackStatus,
    code: stringValue(embedded?.code) || parsed.code || "stream_error",
    message:
      stringValue(embedded?.message) ||
      (error instanceof Error ? error.message : parsed.message),
    retryAfterMs: nullableNonNegativeNumber(embedded?.retryAfterMs),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringify(value: unknown) {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nullableNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function runProviderFailover<TContext, TResult>(input: {
  initialContext: TContext;
  credentialId: (context: TContext) => string;
  execute: (context: TContext, attemptIndex: number) => Promise<TResult>;
  shouldRetry: (result: TResult, attemptIndex: number) => boolean;
  prepareRetryResult: (
    context: TContext,
    result: TResult,
    attemptIndex: number,
  ) => Promise<TResult> | TResult;
  handleAttemptError: (
    context: TContext,
    error: unknown,
    attemptIndex: number,
  ) => Promise<void> | void;
  selectNext: (
    excludedCredentialIds: ReadonlySet<string>,
    attemptIndex: number,
  ) => Promise<TContext> | TContext;
  maxAttempts?: number;
}) {
  const maxAttempts = Math.max(
    1,
    Math.floor(input.maxAttempts || DEFAULT_PROVIDER_FAILOVER_ATTEMPTS),
  );
  const excludedCredentialIds = new Set<string>();
  let context = input.initialContext;
  let lastResult: TResult | null = null;
  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      const result = await input.execute(context, attemptIndex);
      if (
        !input.shouldRetry(result, attemptIndex) ||
        attemptIndex + 1 >= maxAttempts
      ) {
        return { context, result, attempts: attemptIndex + 1 };
      }
      lastResult = await input.prepareRetryResult(
        context,
        result,
        attemptIndex,
      );
      lastError = null;
    } catch (error) {
      await input.handleAttemptError(context, error, attemptIndex);
      lastResult = null;
      lastError = error;
    }

    if (attemptIndex + 1 >= maxAttempts) {
      throw lastError || new Error("Provider failover attempts exhausted");
    }

    excludedCredentialIds.add(input.credentialId(context));
    try {
      context = await input.selectNext(excludedCredentialIds, attemptIndex);
    } catch (selectionError) {
      if (lastResult !== null) {
        return { context, result: lastResult, attempts: attemptIndex + 1 };
      }
      throw lastError || selectionError;
    }
  }

  throw lastError || new Error("Provider failover attempts exhausted");
}
