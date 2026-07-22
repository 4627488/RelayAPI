import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { listGrokUpstreamModels } from "@/src/server/services/grokModels";

const CREATED_2024_01_01 = 1704067200;
const REMOTE_CATALOG_CACHE_MS = 5 * 60 * 1000;
const REMOTE_CATALOG_TIMEOUT_MS = 30 * 1000;
const REMOTE_MODEL_URLS = [
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
  "https://models.router-for.me/models.json",
];

type ModelEntry = Record<string, unknown> & { id: string; object: string };

type Catalog = Record<string, ModelEntry[]>;

let remoteCatalogCache: {
  data: Catalog | null;
  source: string;
  expiresAt: number;
} = {
  data: null,
  source: "",
  expiresAt: 0,
};

const FALLBACK_MODEL_BY_ID = new Map(
  [
    model("gpt-5.2", "GPT 5.2", 1765440000),
    model("gpt-5.3-codex", "GPT 5.3 Codex", 1770307200),
    model("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", 1770912000),
    model("gpt-5.4", "GPT 5.4", 1772668800),
    model("gpt-5.4-mini", "GPT 5.4 Mini", 1773705600),
    model("gpt-5.5", "GPT 5.5", 1776902400),
    model("codex-auto-review", "Codex Auto Review", 1776902400),
    model("gpt-image-2", "GPT Image 2", CREATED_2024_01_01),
  ].map((entry) => [entry.id, entry]),
);

const MODEL_THINKING_SUFFIX_LEVELS = ["high", "xhigh"] as const;

const FALLBACK_PLAN_MODEL_IDS: Record<string, string[]> = {
  free: [
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "codex-auto-review",
    "gpt-image-2",
  ],
  team: [
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "codex-auto-review",
    "gpt-image-2",
  ],
  plus: [
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "codex-auto-review",
    "gpt-image-2",
  ],
  pro: [
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "codex-auto-review",
    "gpt-image-2",
  ],
};

export async function createModelsResponse(
  input: {
    planType?: string;
    openAICompatible?: boolean;
    modelAllowlist?: string[];
  } = {},
) {
  const plan = normalizePlan(input.planType);
  const catalog = await getModelsCatalog();
  let data = getCodexModelsFromCatalog(catalog.data, plan, {
    includeDefault: true,
  });
  const modelAllowlist = input.modelAllowlist || [];
  if (input.openAICompatible) {
    let models = withThinkingSuffixModels(data);
    if (modelAllowlist.length > 0) {
      models = models.filter((entry) =>
        modelMatchesAllowlist(entry.id, modelAllowlist),
      );
    }
    return {
      object: "list",
      data: models.map((entry) => ({
        id: entry.id,
        object: entry.object || "model",
        ...(entry.created ? { created: entry.created } : {}),
        ...(entry.owned_by ? { owned_by: entry.owned_by } : {}),
      })),
    };
  }
  if (modelAllowlist.length > 0) {
    data = data.filter((entry) =>
      modelMatchesAllowlist(entry.id, modelAllowlist),
    );
  }
  return {
    object: "list",
    provider: "codex",
    plan_type: plan,
    catalog_source: catalog.source,
    data,
  };
}

export async function listUpstreamModelIds() {
  const [response, grokModels] = await Promise.all([
    listCodexUpstreamModelIds(),
    listGrokCatalogModelIds(),
  ]);
  return [...new Set([...response, ...grokModels])];
}

export async function listCodexUpstreamModelIds() {
  const response = await createModelsResponse({ planType: "pro", openAICompatible: true });
  return response.data.map((entry) => entry.id).filter(Boolean);
}

export async function listGrokCatalogModelIds() {
  return (await listGrokCatalogModels()).map((entry) => entry.id);
}

export async function listGrokCatalogModels() {
  const [catalog, upstream] = await Promise.all([
    getModelsCatalog(),
    listGrokUpstreamModels(),
  ]);
  const byId = new Map<string, ModelEntry>();
  const catalogModels = Array.isArray(catalog.data.xai)
    ? catalog.data.xai.map(normalizeModelEntry)
    : [];
  for (const entry of catalogModels) if (entry.id) byId.set(entry.id, entry);
  for (const entry of upstream) {
    byId.set(entry.id, {
      ...(byId.get(entry.id) || fallbackGrokModel(entry.id)),
      ...entry,
      id: entry.id,
      object: "model",
    });
  }
  return [...byId.values()];
}

export async function createCodexModelsManifest(input: { modelAllowlist?: string[] } = {}) {
  const [codex, grok] = await Promise.all([
    createModelsResponse({ planType: "pro" }),
    listGrokCatalogModels(),
  ]);
  const allowlist = input.modelAllowlist || [];
  const models = [...codex.data, ...grok]
    .filter((entry) => allowlist.length === 0 || modelMatchesAllowlist(entry.id, allowlist))
    .map((entry, index) => codexManifestEntry(entry, index));
  return { models };
}

export function normalizePlan(planType?: string) {
  const normalized = String(planType || "")
    .trim()
    .toLowerCase();
  if (normalized === "plus") {
    return "plus";
  }
  if (
    normalized === "team" ||
    normalized === "business" ||
    normalized === "go"
  ) {
    return "team";
  }
  if (normalized === "free") {
    return "free";
  }
  return "pro";
}

async function getModelsCatalog() {
  const now = Date.now();
  if (remoteCatalogCache.data && now < remoteCatalogCache.expiresAt) {
    return remoteCatalogCache as {
      data: Catalog;
      source: string;
      expiresAt: number;
    };
  }
  const remote = await fetchRemoteModelsCatalog();
  if (remote) {
    remoteCatalogCache = {
      data: remote.data,
      source: remote.source,
      expiresAt: now + REMOTE_CATALOG_CACHE_MS,
    };
    return remoteCatalogCache as {
      data: Catalog;
      source: string;
      expiresAt: number;
    };
  }
  return { data: fallbackCatalog(), source: "fallback", expiresAt: 0 };
}

async function fetchRemoteModelsCatalog() {
  for (const url of REMOTE_MODEL_URLS) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REMOTE_CATALOG_TIMEOUT_MS),
      });
      if (!response.ok) {
        continue;
      }
      const data = (await response.json()) as Catalog;
      if (isUsableCatalog(data)) {
        return { data, source: url };
      }
    } catch {
      // Try next URL, then fallback to embedded definitions.
    }
  }
  return null;
}

function isUsableCatalog(data: unknown) {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    ["codex-free", "codex-team", "codex-plus", "codex-pro"].some((key) =>
      Array.isArray((data as Record<string, unknown>)[key]),
    )
  );
}

function getCodexModelsFromCatalog(
  catalog: Catalog,
  planType: string,
  options: { includeDefault?: boolean } = {},
) {
  const plan = normalizePlan(planType);
  const key = `codex-${plan}`;
  let models = Array.isArray(catalog[key]) ? catalog[key] : [];
  if (models.length === 0 && plan !== "pro") {
    models = Array.isArray(catalog["codex-pro"]) ? catalog["codex-pro"] : [];
  }
  if (models.length === 0) {
    models = fallbackModels(plan);
  }
  models = upsertById(
    models.map(normalizeModelEntry),
    fallbackModelById("gpt-image-2"),
  );
  if (
    options.includeDefault &&
    serverConfig.codexDefaultModel &&
    !models.some((entry) => entry.id === serverConfig.codexDefaultModel)
  ) {
    models = [fallbackModelById(serverConfig.codexDefaultModel), ...models];
  }
  return models.map((entry) => structuredClone(entry));
}

function fallbackCatalog(): Catalog {
  return {
    "codex-free": fallbackModels("free"),
    "codex-team": fallbackModels("team"),
    "codex-plus": fallbackModels("plus"),
    "codex-pro": fallbackModels("pro"),
  };
}

function fallbackModels(planType: string) {
  const ids =
    FALLBACK_PLAN_MODEL_IDS[normalizePlan(planType)] ||
    FALLBACK_PLAN_MODEL_IDS.pro;
  return [...new Set(ids)].map(fallbackModelById);
}

function fallbackModelById(id: string): ModelEntry {
  const found = FALLBACK_MODEL_BY_ID.get(id);
  if (found) {
    return structuredClone(found);
  }
  return model(id, id, CREATED_2024_01_01);
}

function fallbackGrokModel(id: string): ModelEntry {
  return { ...model(id, id, CREATED_2024_01_01), owned_by: "xai", type: "xai", context_length: 128000, max_completion_tokens: 65536 };
}

export function codexManifestEntry(entry: ModelEntry, index: number) {
  const rawLevels = Array.isArray((entry.thinking as Record<string, unknown> | undefined)?.levels)
    ? ((entry.thinking as Record<string, unknown>).levels as unknown[]).map((level) => String(level).trim().toLowerCase())
    : ["low", "medium", "high"];
  const levels = [...new Set(rawLevels.filter((level) => ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(level)))];
  const supported = (levels.length ? levels : ["medium"]).map((effort) => ({ effort, description: reasoningDescription(effort) }));
  const defaultReasoning = levels.includes("medium") ? "medium" : levels.find((level) => level !== "none") || levels[0] || "medium";
  const contextWindow = positiveInteger(entry.context_length) || 128000;
  return {
    slug: entry.id,
    display_name: String(entry.display_name || entry.name || entry.id),
    description: String(entry.description || `${entry.id} via RelayAPI`),
    context_window: contextWindow,
    max_context_window: contextWindow,
    default_reasoning_level: defaultReasoning,
    supported_reasoning_levels: supported,
    supports_reasoning_summaries: true,
    supports_reasoning_summary_parameter: true,
    supports_parallel_tool_calls: true,
    support_verbosity: false,
    prefer_websockets: false,
    visibility: "list",
    minimal_client_version: "0.0.0",
    supported_in_api: true,
    priority: index + 1,
    base_instructions: "You are a coding agent. Follow the developer and user instructions.",
  };
}

function reasoningDescription(level: string) {
  if (level === "none") return "No reasoning";
  if (level === "low") return "Fast responses with lighter reasoning";
  if (level === "medium") return "Balances speed and reasoning depth";
  return `${level} reasoning depth`;
}

function positiveInteger(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }

function normalizeModelEntry(entry: Record<string, unknown>): ModelEntry {
  const id = String(entry?.id || entry?.name || "").trim();
  return {
    ...structuredClone(entry || {}),
    id,
    object: String(entry?.object || "model"),
    owned_by: entry?.owned_by || entry?.ownedBy || "openai",
  };
}

function upsertById(models: ModelEntry[], ...extras: ModelEntry[]) {
  const byId = new Map<string, ModelEntry>();
  for (const entry of [...models, ...extras]) {
    if (entry.id) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}

function model(id: string, displayName: string, created: number): ModelEntry {
  return {
    id,
    object: "model",
    created,
    owned_by: "openai",
    type: "openai",
    display_name: displayName,
    version: id,
    context_length: 400000,
    max_completion_tokens: 128000,
    supported_parameters: ["tools"],
    ...(id === "gpt-image-2"
      ? {}
      : { thinking: { levels: ["low", "medium", "high", "xhigh"] } }),
  };
}

function modelMatchesAllowlist(modelId: string, allowlist: string[]) {
  const parsed = parseThinkingSuffixModel(modelId);
  return allowlist.some((allowed) => {
    const cleanAllowed = String(allowed || "").trim();
    return (
      cleanAllowed === modelId ||
      (parsed.hasSuffix && cleanAllowed === parsed.baseModel)
    );
  });
}

function parseThinkingSuffixModel(modelId: string) {
  const value = String(modelId || "").trim();
  const lastOpen = value.lastIndexOf("(");
  if (lastOpen <= 0 || !value.endsWith(")")) {
    return { baseModel: value, hasSuffix: false };
  }
  const baseModel = value.slice(0, lastOpen).trim();
  const suffix = value
    .slice(lastOpen + 1, -1)
    .trim()
    .toLowerCase();
  if (!baseModel || !MODEL_THINKING_SUFFIX_LEVELS.includes(suffix as never)) {
    return { baseModel: value, hasSuffix: false };
  }
  return { baseModel, hasSuffix: true };
}

function withThinkingSuffixModels(models: ModelEntry[]) {
  const output: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    addModelEntry(output, seen, entry);
    for (const level of thinkingLevelsForModel(entry)) {
      addModelEntry(output, seen, modelWithThinkingSuffix(entry, level));
    }
  }
  return output;
}

function modelWithThinkingSuffix(
  entry: ModelEntry,
  level: (typeof MODEL_THINKING_SUFFIX_LEVELS)[number],
): ModelEntry {
  return {
    ...structuredClone(entry),
    id: `${entry.id}(${level})`,
    display_name: `${String(entry.display_name || entry.id)} (${level})`,
  };
}

function thinkingLevelsForModel(entry: ModelEntry) {
  if (!supportsThinkingSuffix(entry)) {
    return [];
  }
  const configuredLevels = Array.isArray(
    (entry.thinking as Record<string, unknown> | undefined)?.levels,
  )
    ? ((entry.thinking as Record<string, unknown>).levels as unknown[])
        .map((level) => String(level).trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (configuredLevels.length === 0) {
    return [...MODEL_THINKING_SUFFIX_LEVELS];
  }
  return MODEL_THINKING_SUFFIX_LEVELS.filter((level) =>
    configuredLevels.includes(level),
  );
}

function supportsThinkingSuffix(entry: ModelEntry) {
  if (!entry.id || entry.id.includes("(") || entry.id === "gpt-image-2") {
    return false;
  }
  if (entry.thinking === false) {
    return false;
  }
  const supportedParameters = entry.supported_parameters;
  if (Array.isArray(supportedParameters) && supportedParameters.length > 0) {
    return (
      supportedParameters.includes("tools") ||
      supportedParameters.includes("reasoning")
    );
  }
  return true;
}

function addModelEntry(
  output: ModelEntry[],
  seen: Set<string>,
  entry: ModelEntry,
) {
  if (!entry.id || seen.has(entry.id)) {
    return;
  }
  seen.add(entry.id);
  output.push(entry);
}
