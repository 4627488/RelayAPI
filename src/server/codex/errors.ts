import "server-only";

export interface CodexUpstreamErrorInput {
  statusCode?: number | null;
  body?: unknown;
  now?: Date;
}

export interface CodexUpstreamErrorInfo {
  statusCode: number | null;
  code: string;
  message: string;
  retryAfterMs: number | null;
  credentialScoped: boolean;
  requestScoped: boolean;
  clearReplay: boolean;
}

const MODEL_CAPACITY_COOLDOWN_MS = 60_000;

export function classifyCodexUpstreamError(
  input: CodexUpstreamErrorInput,
): CodexUpstreamErrorInfo {
  const statusCode = normalizeStatusCode(input.statusCode);
  const body = input.body;
  const message = extractErrorMessage(body) || statusText(statusCode);
  const lower = stringifyErrorBody(body).toLowerCase();
  const upstreamCode = stringAt(body, "error.code") || stringAt(body, "code");
  const upstreamType = stringAt(body, "error.type") || stringAt(body, "type");
  const normalizedCode = upstreamCode.trim().toLowerCase();
  const normalizedType = upstreamType.trim().toLowerCase();

  if (containsWebSocketConnectionLimit(body, lower)) {
    return info({
      statusCode,
      code: "websocket_connection_limit_reached",
      message,
      retryAfterMs: 0,
      credentialScoped: false,
      requestScoped: false,
      clearReplay: false,
    });
  }

  if (normalizedType === "usage_limit_reached") {
    return info({
      statusCode,
      code: "usage_limit_reached",
      message,
      retryAfterMs: usageLimitRetryAfterMs(body, input.now || new Date()),
      credentialScoped: true,
      requestScoped: false,
      clearReplay: false,
    });
  }

  if (isContextTooLarge(statusCode, normalizedCode, lower)) {
    return info({
      statusCode,
      code: "context_too_large",
      message,
      retryAfterMs: null,
      credentialScoped: false,
      requestScoped: true,
      clearReplay: false,
    });
  }

  if (isThinkingSignatureInvalid(normalizedCode, lower)) {
    return info({
      statusCode,
      code: "thinking_signature_invalid",
      message,
      retryAfterMs: null,
      credentialScoped: false,
      requestScoped: true,
      clearReplay: true,
    });
  }

  if (isModelCapacity(lower)) {
    return info({
      statusCode,
      code: "model_capacity",
      message,
      retryAfterMs: MODEL_CAPACITY_COOLDOWN_MS,
      credentialScoped: true,
      requestScoped: false,
      clearReplay: false,
    });
  }

  return info({
    statusCode,
    code: normalizedCode || normalizedType || "upstream_error",
    message,
    retryAfterMs: null,
    credentialScoped:
      statusCode === 401 || statusCode === 403 || statusCode === 429,
    requestScoped: false,
    clearReplay: false,
  });
}

export function classifyCodexStreamEvent(
  event: unknown,
  input: { statusCode?: number | null; now?: Date } = {},
) {
  if (!isRecord(event)) {
    return null;
  }
  const eventType = stringValue(event.type);
  if (eventType === "error") {
    return classifyCodexUpstreamError({
      statusCode: input.statusCode || numberValue(event.status) || 400,
      body: event,
      now: input.now,
    });
  }
  if (eventType !== "response.failed") {
    return null;
  }
  const body = { error: recordAt(event, "response.error") || event.error };
  return classifyCodexUpstreamError({
    statusCode: input.statusCode || 400,
    body,
    now: input.now,
  });
}

function info(input: CodexUpstreamErrorInfo): CodexUpstreamErrorInfo {
  return input;
}

function usageLimitRetryAfterMs(body: unknown, now: Date) {
  const resetsAt = numberAt(body, "error.resets_at");
  if (resetsAt > 0) {
    return Math.max(0, resetsAt * 1000 - now.getTime());
  }
  const resetsInSeconds = numberAt(body, "error.resets_in_seconds");
  if (resetsInSeconds > 0) {
    return resetsInSeconds * 1000;
  }
  return null;
}

function isContextTooLarge(
  statusCode: number | null,
  upstreamCode: string,
  lower: string,
) {
  return (
    statusCode === 413 ||
    upstreamCode === "context_length_exceeded" ||
    upstreamCode === "context_too_large" ||
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("too many tokens")
  );
}

function isThinkingSignatureInvalid(upstreamCode: string, lower: string) {
  return (
    upstreamCode === "invalid_encrypted_content" ||
    lower.includes("invalid_encrypted_content") ||
    lower.includes("invalid signature in thinking block")
  );
}

function isModelCapacity(lower: string) {
  return (
    lower.includes("selected model is at capacity") ||
    lower.includes("model is at capacity. please try a different model")
  );
}

function containsWebSocketConnectionLimit(body: unknown, lower: string) {
  return (
    stringAt(body, "error.code") === "websocket_connection_limit_reached" ||
    stringAt(body, "error.type") === "websocket_connection_limit_reached" ||
    stringAt(body, "body.error.code") ===
      "websocket_connection_limit_reached" ||
    stringAt(body, "body.error.type") ===
      "websocket_connection_limit_reached" ||
    lower.includes("websocket_connection_limit_reached")
  );
}

function extractErrorMessage(body: unknown): string {
  return (
    stringAt(body, "error.message") ||
    stringAt(body, "body.error.message") ||
    stringAt(body, "message") ||
    stringAt(body, "error.code") ||
    stringAt(body, "error.type")
  );
}

function stringifyErrorBody(body: unknown) {
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body ?? {});
  } catch {
    return String(body ?? "");
  }
}

function statusText(statusCode: number | null) {
  return statusCode ? `Upstream request failed with status ${statusCode}` : "";
}

function normalizeStatusCode(statusCode: unknown) {
  const value = numberValue(statusCode);
  return value > 0 ? value : null;
}

function numberAt(value: unknown, path: string) {
  return numberValue(valueAt(value, path));
}

function stringAt(value: unknown, path: string) {
  return stringValue(valueAt(value, path));
}

function recordAt(value: unknown, path: string) {
  const next = valueAt(value, path);
  return isRecord(next) ? next : null;
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
