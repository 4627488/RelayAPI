import "server-only";

import crypto from "node:crypto";

import { HttpError } from "@/src/server/http/errors";
import {
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
import {
  normalizeLiteLlmCatalog,
  resolveModelPrice,
  type ModelPriceEntry,
} from "@/src/server/services/modelPricing";
import {
  getEffectiveQuotaBaselines,
  setQuotaBaselineOverride,
} from "@/src/server/services/quotaCalibration";

const PRICING_CONFIG_KEY = "model_pricing_config_v1";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type StoredPrice = {
  model: string;
  source: "admin" | "litellm";
  version: string;
  inputNanoUsdPerToken: string;
  outputNanoUsdPerToken: string;
  cachedInputNanoUsdPerToken: string;
  cacheWriteNanoUsdPerToken: string;
  reasoningNanoUsdPerToken: string;
};

type PricingConfig = {
  aliases: Record<string, string>;
  overrides: StoredPrice[];
  catalog: StoredPrice[];
  catalogVersion: string | null;
  catalogUpdatedAt: string | null;
  catalogError: string | null;
};

export function resolveConfiguredModelPrice(model: string) {
  const config = readPricingConfig();
  return resolveModelPrice(model, {
    aliases: config.aliases,
    overrides: config.overrides.map(fromStoredPrice),
    catalog: config.catalog.map(fromStoredPrice),
  });
}

export function attachConfiguredModelPrices<T extends {
  models: Array<{ model: string; pricing?: unknown }>;
}>(analysis: T): T {
  return {
    ...analysis,
    models: analysis.models.map((row) => {
      const price = resolveConfiguredModelPrice(row.model);
      return {
        ...row,
        pricing: price ? {
          inputNanoUsdPerToken: String(price.inputNanoUsdPerToken),
          outputNanoUsdPerToken: String(price.outputNanoUsdPerToken),
          cachedInputNanoUsdPerToken: String(price.cachedInputNanoUsdPerToken),
          cacheWriteNanoUsdPerToken: String(price.cacheWriteNanoUsdPerToken),
          reasoningNanoUsdPerToken: String(price.reasoningNanoUsdPerToken),
        } : null,
      };
    }),
  } as T;
}

export function getQuotaAdministration() {
  const config = readPricingConfig();
  const baselines = getEffectiveQuotaBaselines();
  return {
    baselines: Object.fromEntries(
      (["5h", "7d"] as const).map((kind) => [kind, {
        automaticNanoUsd: stringOrNull(baselines[kind].automaticNanoUsd),
        overrideNanoUsd: stringOrNull(baselines[kind].overrideNanoUsd),
        effectiveNanoUsd: stringOrNull(baselines[kind].effectiveNanoUsd),
        confidence: baselines[kind].confidence,
        sampleCount: baselines[kind].sampleCount,
      }]),
    ) as Record<"5h" | "7d", {
      automaticNanoUsd: string | null;
      overrideNanoUsd: string | null;
      effectiveNanoUsd: string | null;
      confidence: number;
      sampleCount: number;
    }>,
    pricing: {
      aliases: config.aliases,
      overrides: config.overrides,
      catalogModelCount: config.catalog.length,
      catalogVersion: config.catalogVersion,
      catalogUpdatedAt: config.catalogUpdatedAt,
      catalogError: config.catalogError,
    },
  };
}

export function patchQuotaAdministration(input: unknown) {
  const body = objectValue(input);
  const config = readPricingConfig();
  const baselines = objectValue(body.baselines);
  if (baselines) {
    for (const kind of ["5h", "7d"] as const) {
      if (Object.hasOwn(baselines, kind)) {
        setQuotaBaselineOverride(kind, nullablePositiveBigInt(baselines[kind], `${kind} baseline`));
      }
    }
  }
  if (Object.hasOwn(body, "aliases")) {
    const aliases = objectValue(body.aliases);
    config.aliases = Object.fromEntries(
      Object.entries(aliases).map(([alias, model]) => [clean(alias), clean(model)]),
    );
  }
  if (Object.hasOwn(body, "overrides")) {
    const overrides = objectValue(body.overrides);
    config.overrides = Object.entries(overrides).map(([model, raw]) =>
      toStoredPrice(normalizeAdminPrice(model, raw)),
    );
  }
  writePricingConfig(config);
  return getQuotaAdministration();
}

export async function refreshLiteLlmPricing() {
  const config = readPricingConfig();
  try {
    const response = await fetch(LITELLM_URL, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`LiteLLM catalog returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 5 * 1024 * 1024) {
      throw new Error("LiteLLM catalog exceeds 5 MiB");
    }
    const version = `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
    const entries = normalizeLiteLlmCatalog(JSON.parse(text), version);
    if (entries.length < 10) {
      throw new Error("LiteLLM catalog did not contain enough priced models");
    }
    config.catalog = entries.map(toStoredPrice);
    config.catalogVersion = version;
    config.catalogUpdatedAt = new Date().toISOString();
    config.catalogError = null;
    writePricingConfig(config);
    return getQuotaAdministration();
  } catch (error) {
    config.catalogError = error instanceof Error ? error.message : String(error);
    writePricingConfig(config);
    throw new HttpError(502, "pricing_catalog_refresh_failed", config.catalogError);
  }
}

function normalizeAdminPrice(model: string, value: unknown): ModelPriceEntry {
  const row = objectValue(value);
  const input = positiveBigInt(row.inputNanoUsdPerToken, "input price");
  const output = positiveBigInt(row.outputNanoUsdPerToken, "output price");
  return {
    model: clean(model),
    source: "admin",
    version: `admin:${Date.now()}`,
    inputNanoUsdPerToken: input,
    outputNanoUsdPerToken: output,
    cachedInputNanoUsdPerToken: nullablePositiveBigInt(row.cachedInputNanoUsdPerToken, "cached input price") ?? input,
    cacheWriteNanoUsdPerToken: nullablePositiveBigInt(row.cacheWriteNanoUsdPerToken, "cache write price") ?? input,
    reasoningNanoUsdPerToken: nullablePositiveBigInt(row.reasoningNanoUsdPerToken, "reasoning price") ?? output,
  };
}

function readPricingConfig(): PricingConfig {
  const empty: PricingConfig = { aliases: {}, overrides: [], catalog: [], catalogVersion: null, catalogUpdatedAt: null, catalogError: null };
  const raw = getSettingValue(PRICING_CONFIG_KEY);
  if (!raw) return empty;
  try { return { ...empty, ...(JSON.parse(raw) as Partial<PricingConfig>) }; } catch { return empty; }
}

function writePricingConfig(config: PricingConfig) {
  upsertSettingValue(PRICING_CONFIG_KEY, JSON.stringify(config));
}

function toStoredPrice(price: ModelPriceEntry): StoredPrice {
  return {
    ...price,
    source: price.source === "admin" ? "admin" : "litellm",
    inputNanoUsdPerToken: String(price.inputNanoUsdPerToken),
    outputNanoUsdPerToken: String(price.outputNanoUsdPerToken),
    cachedInputNanoUsdPerToken: String(price.cachedInputNanoUsdPerToken),
    cacheWriteNanoUsdPerToken: String(price.cacheWriteNanoUsdPerToken),
    reasoningNanoUsdPerToken: String(price.reasoningNanoUsdPerToken),
  };
}

function fromStoredPrice(price: StoredPrice): ModelPriceEntry {
  return {
    ...price,
    inputNanoUsdPerToken: BigInt(price.inputNanoUsdPerToken),
    outputNanoUsdPerToken: BigInt(price.outputNanoUsdPerToken),
    cachedInputNanoUsdPerToken: BigInt(price.cachedInputNanoUsdPerToken),
    cacheWriteNanoUsdPerToken: BigInt(price.cacheWriteNanoUsdPerToken),
    reasoningNanoUsdPerToken: BigInt(price.reasoningNanoUsdPerToken),
  };
}

function positiveBigInt(value: unknown, label: string) {
  const parsed = nullablePositiveBigInt(value, label);
  if (parsed === null) throw new HttpError(400, "invalid_pricing", `${label} is required`);
  return parsed;
}

function nullablePositiveBigInt(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(String(value));
    if (parsed <= BigInt(0)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_quota_value", `${label} must be a positive integer`);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function clean(value: unknown) { return String(value || "").trim(); }
function stringOrNull(value: bigint | null) { return value === null ? null : String(value); }
