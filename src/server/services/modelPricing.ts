import bundledCatalog from "@/src/server/pricing/litellm-fallback.json";

export type ModelPriceSource = "admin" | "litellm" | "bundled";

export interface ModelPriceEntry {
  model: string;
  source: ModelPriceSource;
  version: string;
  inputNanoUsdPerToken: bigint;
  outputNanoUsdPerToken: bigint;
  cachedInputNanoUsdPerToken: bigint;
  cacheWriteNanoUsdPerToken: bigint;
  reasoningNanoUsdPerToken: bigint;
}

export interface ModelPriceSnapshot extends ModelPriceEntry {
  requestedModel: string;
  pricedModel: string;
}

export interface PricedUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface RequestCostBreakdown {
  inputNanoUsd: bigint;
  outputNanoUsd: bigint;
  cachedInputNanoUsd: bigint;
  cacheWriteNanoUsd: bigint;
  reasoningNanoUsd: bigint;
  totalNanoUsd: bigint;
}

export interface ResolveModelPriceOptions {
  aliases?: Record<string, string>;
  catalog?: ModelPriceEntry[];
  bundled?: ModelPriceEntry[];
  overrides?: ModelPriceEntry[];
}

export function resolveModelPrice(
  model: string,
  options: ResolveModelPriceOptions = {},
): ModelPriceSnapshot | null {
  const requestedModel = cleanModel(model);
  const pricedModel = cleanModel(options.aliases?.[requestedModel] || requestedModel);
  if (!pricedModel) {
    return null;
  }
  const entry =
    findPrice(options.overrides, pricedModel) ||
    findPrice(options.catalog, pricedModel) ||
    findPrice(options.bundled || BUNDLED_PRICES, pricedModel);
  if (!entry) {
    return null;
  }
  return {
    ...entry,
    requestedModel,
    pricedModel,
  };
}

const BUNDLED_PRICES = normalizeLiteLlmCatalog(
  bundledCatalog.models,
  bundledCatalog.catalogVersion,
).map((entry) => ({ ...entry, source: "bundled" as const }));

export function calculateRequestCost(
  price: ModelPriceSnapshot,
  usage: PricedUsageSnapshot,
): RequestCostBreakdown {
  const inputTokens = tokens(usage.inputTokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    tokens(usage.cachedInputTokens),
  );
  const inputNanoUsd =
    BigInt(inputTokens - cachedInputTokens) * price.inputNanoUsdPerToken;
  const outputNanoUsd =
    BigInt(tokens(usage.outputTokens)) * price.outputNanoUsdPerToken;
  const cachedInputNanoUsd =
    BigInt(cachedInputTokens) * price.cachedInputNanoUsdPerToken;
  const cacheWriteNanoUsd =
    BigInt(tokens(usage.cacheWriteTokens)) * price.cacheWriteNanoUsdPerToken;
  const reasoningNanoUsd =
    BigInt(tokens(usage.reasoningTokens)) * price.reasoningNanoUsdPerToken;
  return {
    inputNanoUsd,
    outputNanoUsd,
    cachedInputNanoUsd,
    cacheWriteNanoUsd,
    reasoningNanoUsd,
    totalNanoUsd:
      inputNanoUsd +
      outputNanoUsd +
      cachedInputNanoUsd +
      cacheWriteNanoUsd +
      reasoningNanoUsd,
  };
}

export function normalizeLiteLlmCatalog(
  payload: unknown,
  version: string,
): ModelPriceEntry[] {
  if (!isObject(payload)) {
    throw new Error("LiteLLM price catalog must be an object");
  }
  const entries: ModelPriceEntry[] = [];
  for (const [model, raw] of Object.entries(payload)) {
    if (!isObject(raw)) {
      continue;
    }
    const input = priceToNanoUsd(raw.input_cost_per_token);
    const output = priceToNanoUsd(raw.output_cost_per_token);
    if (input === null || output === null) {
      continue;
    }
    entries.push({
      model,
      source: "litellm",
      version,
      inputNanoUsdPerToken: input,
      outputNanoUsdPerToken: output,
      cachedInputNanoUsdPerToken:
        priceToNanoUsd(raw.cache_read_input_token_cost) ?? input,
      cacheWriteNanoUsdPerToken:
        priceToNanoUsd(raw.cache_creation_input_token_cost) ?? input,
      reasoningNanoUsdPerToken:
        priceToNanoUsd(raw.output_cost_per_reasoning_token) ?? output,
    });
  }
  return entries;
}

function findPrice(entries: ModelPriceEntry[] | undefined, model: string) {
  return entries?.find((entry) => cleanModel(entry.model) === model) || null;
}

function priceToNanoUsd(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return BigInt(Math.round(value * 1_000_000_000));
}

function tokens(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function cleanModel(value: unknown) {
  return String(value || "").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
