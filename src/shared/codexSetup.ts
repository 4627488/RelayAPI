export const RELAY_DEFAULT_BASE_URL = "https://ai.cafebabe.top/v1";
export const RELAY_PROVIDER_NAME = "relayapi";
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export type CodexModelManifest = {
  models: Array<Record<string, unknown> & { slug: string }>;
};

export function buildCodexConfig(
  model: string,
  apiKey: string,
  baseUrl = RELAY_DEFAULT_BASE_URL,
) {
  const tokenCommand = `[Console]::Out.Write('${powerShellSingleQuoted(apiKey)}')`;

  return `model = "${tomlString(model)}"
model_provider = "${RELAY_PROVIDER_NAME}"
model_reasoning_effort = "medium"

[model_providers.${RELAY_PROVIDER_NAME}]
name = "RelayAPI"
base_url = "${tomlString(normalizeRelayBaseUrl(baseUrl))}"
wire_api = "responses"

[model_providers.${RELAY_PROVIDER_NAME}.auth]
command = "powershell"
args = [
  "-NoProfile",
  "-Command",
  "${tomlString(tokenCommand)}"
]
timeout_ms = 5000
refresh_interval_ms = 0

[windows]
sandbox = "elevated"
`;
}

export function buildOpenCodeConfig(
  model: string,
  manifest: CodexModelManifest,
  apiKey: string,
  baseUrl = RELAY_DEFAULT_BASE_URL,
) {
  const models = Object.fromEntries(
    manifest.models.map((entry) => [
      entry.slug,
      {
        name:
          typeof entry.display_name === "string" && entry.display_name.trim()
            ? entry.display_name.trim()
            : entry.slug,
      },
    ]),
  );
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: `${RELAY_PROVIDER_NAME}/${model}`,
      provider: {
        [RELAY_PROVIDER_NAME]: {
          npm: "@ai-sdk/openai",
          name: "RelayAPI",
          options: {
            baseURL: normalizeRelayBaseUrl(baseUrl),
            apiKey,
          },
          models,
        },
      },
    },
    null,
    2,
  );
}

export function buildPowerShellEnvironment(apiKey: string) {
  return `$env:RELAY_API_KEY = "${apiKey.replaceAll('"', '`"')}"`;
}

export function buildPosixEnvironment(apiKey: string) {
  return `export RELAY_API_KEY='${apiKey.replaceAll("'", `'"'"'`)}'`;
}

export function buildOpenAIEnvironment(
  apiKey: string,
  baseUrl = RELAY_DEFAULT_BASE_URL,
) {
  return `OPENAI_BASE_URL=${normalizeRelayBaseUrl(baseUrl)}
OPENAI_API_KEY=${apiKey}`;
}

export function normalizeRelayBaseUrl(value: string) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return RELAY_DEFAULT_BASE_URL;
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function parseCodexModelManifest(payload: unknown): CodexModelManifest {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const models = Array.isArray(root?.models) ? root.models : [];
  if (models.length === 0) throw new Error("上游没有返回 Codex 模型元数据");

  const parsed: CodexModelManifest["models"] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Codex 模型元数据格式无效");
    }
    const entry = raw as Record<string, unknown>;
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!slug || seen.has(slug)) throw new Error("Codex 模型元数据包含无效或重复的模型");
    seen.add(slug);
    parsed.push({ ...entry, slug });
  }
  return { models: parsed };
}

export function serializeCodexModelManifest(manifest: CodexModelManifest) {
  return JSON.stringify(manifest, null, 2);
}

function tomlString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function powerShellSingleQuoted(value: string) {
  return value.replaceAll("'", "''");
}
