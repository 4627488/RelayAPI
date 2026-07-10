import "server-only";

export type CodexModelHeaderOverrides = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const ALLOWED_HEADERS = new Map([
  ["user-agent", "User-Agent"],
  ["originator", "Originator"],
  ["x-codex-beta-features", "X-Codex-Beta-Features"],
  ["openai-beta", "OpenAI-Beta"],
]);

export function parseCodexModelHeaderOverrides(
  raw: string | undefined,
): CodexModelHeaderOverrides {
  if (!raw?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("CODEX_MODEL_HEADER_OVERRIDES must be valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("CODEX_MODEL_HEADER_OVERRIDES must be a JSON object");
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [rawModel, rawHeaders] of Object.entries(parsed)) {
    const model = rawModel.trim();
    if (!model || !isRecord(rawHeaders)) {
      throw new Error(
        `CODEX_MODEL_HEADER_OVERRIDES.${rawModel} must be a header object`,
      );
    }

    const headers: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(rawHeaders)) {
      const name = ALLOWED_HEADERS.get(rawName.toLowerCase());
      if (!name) {
        throw new Error(
          `CODEX_MODEL_HEADER_OVERRIDES contains unsupported header: ${rawName}`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(
          "CODEX_MODEL_HEADER_OVERRIDES header values must be string values",
        );
      }
      if (/[^\x20-\x7e]/.test(value)) {
        throw new Error(
          "CODEX_MODEL_HEADER_OVERRIDES header values must not contain control characters",
        );
      }
      headers[name] = value;
    }
    result[model] = headers;
  }
  return result;
}

export function applyCodexModelHeaderOverrides(
  headers: Record<string, string>,
  overrides: CodexModelHeaderOverrides,
  model: string,
) {
  return {
    ...headers,
    ...(overrides["*"] || {}),
    ...(overrides[model] || {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
