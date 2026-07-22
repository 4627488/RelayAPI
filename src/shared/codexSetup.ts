export const CODEX_DEFAULT_BASE_URL = "https://ai.cafebabe.top/v1";
export const CODEX_PROVIDER_NAME = "cliproxyapi";
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export type CodexModelManifest = {
  models: Array<Record<string, unknown> & { slug: string }>;
};

export function buildOAuthConfig(model: string, apiKey: string) {
  return `model = "${model}"
model_provider = "${CODEX_PROVIDER_NAME}"
model_reasoning_effort = "xhigh"
plan_mode_reasoning_effort = "xhigh"

${safetyOptions()}

[model_providers.${CODEX_PROVIDER_NAME}]
base_url = "${CODEX_DEFAULT_BASE_URL}"
experimental_bearer_token = "${apiKey}"
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true
`;
}

export function buildApiConfig(model: string) {
  return `${safetyOptions()}

model_provider = "${CODEX_PROVIDER_NAME}"
model = "${model}"
model_reasoning_effort = "high"
model_catalog_json = "./models.json"

[model_providers.${CODEX_PROVIDER_NAME}]
name = "${CODEX_PROVIDER_NAME}"
base_url = "${CODEX_DEFAULT_BASE_URL}"
wire_api = "responses"
`;
}

export function buildCodexAuthJson(apiKey: string) {
  return JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2);
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

function safetyOptions() {
  return `# 无需确认是否执行操作，危险指令，初次接触 Codex 不建议开启，移除 # 号即可开启
# approval_policy = "never"

# 沙箱模式超高权限，危险指令，初次接触 Codex 不建议开启，移除 # 号即可开启
# sandbox_mode = "danger-full-access"`;
}
