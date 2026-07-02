import "server-only";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_240;

type JsonRecord = Record<string, unknown>;

type ReplayItem = JsonRecord & {
  type: "reasoning" | "function_call" | "custom_tool_call";
};

type ReplayEntry = {
  items: ReplayItem[];
  touchedAt: number;
};

const replayEntries = new Map<string, ReplayEntry>();

export interface ReplayScope {
  model: string;
  sessionKey: string;
}

export function getCodexReplaySessionKey(input: {
  payload: unknown;
  headers?: Headers | null;
}) {
  const payload = isRecord(input.payload) ? input.payload : {};
  const promptCacheKey = stringValue(payload.prompt_cache_key);
  if (promptCacheKey) {
    return `prompt-cache:${promptCacheKey}`;
  }

  const metadata = recordValue(payload.client_metadata);
  const windowId = stringValue(metadata?.["x-codex-window-id"]);
  if (windowId) {
    return `window:${windowId}`;
  }

  const turnMetadata = parseTurnMetadata(
    stringValue(metadata?.["x-codex-turn-metadata"]),
  );
  if (turnMetadata.promptCacheKey) {
    return `prompt-cache:${turnMetadata.promptCacheKey}`;
  }
  if (turnMetadata.windowId) {
    return `window:${turnMetadata.windowId}`;
  }

  const headers = input.headers || null;
  if (headers) {
    const headerTurnMetadata = parseTurnMetadata(
      headerValue(headers, "x-codex-turn-metadata"),
    );
    if (headerTurnMetadata.promptCacheKey) {
      return `prompt-cache:${headerTurnMetadata.promptCacheKey}`;
    }
    if (headerTurnMetadata.windowId) {
      return `window:${headerTurnMetadata.windowId}`;
    }
    const headerWindowId = headerValue(headers, "x-codex-window-id");
    if (headerWindowId) {
      return `window:${headerWindowId}`;
    }
    const sessionId =
      headerValue(headers, "session_id") ||
      headerValue(headers, "session-id") ||
      headerValue(headers, "Session_id");
    if (sessionId) {
      return `session:${sessionId}`;
    }
    const conversationId = headerValue(headers, "conversation_id");
    if (conversationId) {
      return `conversation:${conversationId}`;
    }
  }

  return "";
}

export function applyCodexReasoningReplay(input: {
  model: string;
  sessionKey: string;
  payload: JsonRecord;
  nowMs?: number;
}) {
  const scopeKey = replayScopeKey(input);
  const entry = getReplayEntry(scopeKey, input.nowMs ?? Date.now());
  if (!entry || entry.items.length === 0 || !Array.isArray(input.payload.input)) {
    return input.payload;
  }

  const items = replayItemsForInput(entry.items, input.payload.input);
  if (items.length === 0) {
    return input.payload;
  }

  return {
    ...input.payload,
    input: [...cloneJson(items), ...input.payload.input],
  };
}

export function captureCodexReasoningReplay(input: {
  model: string;
  sessionKey: string;
  response: unknown;
  nowMs?: number;
}) {
  const scopeKey = replayScopeKey(input);
  if (!scopeKey) {
    return false;
  }
  const response = isRecord(input.response) ? input.response : {};
  const output = Array.isArray(response.output) ? response.output : [];
  const items = output.flatMap((item) => normalizeReplayItem(item));
  if (items.length === 0) {
    clearCodexReasoningReplay(input);
    return false;
  }
  replayEntries.set(scopeKey, {
    items,
    touchedAt: input.nowMs ?? Date.now(),
  });
  evictReplayEntries();
  return true;
}

export function clearCodexReasoningReplay(input: ReplayScope) {
  const key = replayScopeKey(input);
  if (key) {
    replayEntries.delete(key);
  }
}

export function clearCodexReasoningReplayCache() {
  replayEntries.clear();
}

function replayItemsForInput(items: ReplayItem[], inputItems: unknown[]) {
  const hasReasoning = inputItems.some(
    (item) => isRecord(item) && item.type === "reasoning",
  );
  const existingCalls = new Set(
    inputItems
      .filter(isRecord)
      .filter(
        (item) =>
          item.type === "function_call" || item.type === "custom_tool_call",
      )
      .map((item) => stringValue(item.call_id))
      .filter(Boolean),
  );
  const outputCalls = new Set(
    inputItems
      .filter(isRecord)
      .filter(
        (item) =>
          item.type === "function_call_output" ||
          item.type === "custom_tool_call_output",
      )
      .map((item) => stringValue(item.call_id))
      .filter(Boolean),
  );

  return items.filter((item) => {
    if (item.type === "reasoning") {
      return !hasReasoning;
    }
    const callId = stringValue(item.call_id);
    return Boolean(callId && outputCalls.has(callId) && !existingCalls.has(callId));
  });
}

function normalizeReplayItem(item: unknown): ReplayItem[] {
  if (!isRecord(item)) {
    return [];
  }
  switch (item.type) {
    case "reasoning": {
      const encryptedContent = stringValue(item.encrypted_content);
      if (!encryptedContent) {
        return [];
      }
      return [
        {
          type: "reasoning",
          encrypted_content: encryptedContent,
          summary: [],
          content: null,
        },
      ];
    }
    case "function_call": {
      const callId = stringValue(item.call_id);
      const name = stringValue(item.name);
      const args = stringValue(item.arguments);
      if (!callId || !name) {
        return [];
      }
      return [{ type: "function_call", call_id: callId, name, arguments: args }];
    }
    case "custom_tool_call": {
      const callId = stringValue(item.call_id);
      const name = stringValue(item.name);
      if (!callId || !name || item.input === undefined) {
        return [];
      }
      return [
        {
          type: "custom_tool_call",
          status: stringValue(item.status) || "completed",
          call_id: callId,
          name,
          input: cloneJsonValue(item.input),
        },
      ];
    }
    default:
      return [];
  }
}

function getReplayEntry(key: string, nowMs: number) {
  if (!key) {
    return null;
  }
  const entry = replayEntries.get(key);
  if (!entry) {
    return null;
  }
  if (nowMs - entry.touchedAt > DEFAULT_TTL_MS) {
    replayEntries.delete(key);
    return null;
  }
  entry.touchedAt = nowMs;
  return entry;
}

function evictReplayEntries() {
  if (replayEntries.size <= DEFAULT_MAX_ENTRIES) {
    return;
  }
  const candidates = [...replayEntries.entries()].sort(
    ([, left], [, right]) => left.touchedAt - right.touchedAt,
  );
  for (const [key] of candidates.slice(0, replayEntries.size - DEFAULT_MAX_ENTRIES)) {
    replayEntries.delete(key);
  }
}

function replayScopeKey(input: ReplayScope) {
  const model = input.model.trim();
  const sessionKey = input.sessionKey.trim();
  return model && sessionKey ? `${model}\u0000${sessionKey}` : "";
}

function parseTurnMetadata(raw: string) {
  if (!raw) {
    return { promptCacheKey: "", windowId: "" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { promptCacheKey: "", windowId: "" };
    }
    return {
      promptCacheKey: stringValue(parsed.prompt_cache_key),
      windowId: stringValue(parsed.window_id),
    };
  } catch {
    return { promptCacheKey: "", windowId: "" };
  }
}

function headerValue(headers: Headers, name: string) {
  return headers.get(name)?.trim() || "";
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : null;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function cloneJsonValue(value: unknown) {
  return structuredClone(value);
}

function isRecord(value: unknown): value is JsonRecord {
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
