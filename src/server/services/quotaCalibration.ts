import { codexPlanShares } from "@/src/shared/codexPlans";

export type CalibrationRejectionReason =
  | "window_reset"
  | "incomplete_pricing"
  | "percentage_decreased"
  | "percentage_delta_too_small"
  | "missing_usage";

export type QuotaSampleResult =
  | {
      accepted: true;
      perShareNanoUsd: bigint;
      percentSpan: number;
      planShares: number;
    }
  | { accepted: false; reason: CalibrationRejectionReason };

export function estimateQuotaSample(input: {
  planType: string;
  previousUsedPercent: number;
  currentUsedPercent: number;
  previousResetsAt: string;
  currentResetsAt: string;
  observedNanoUsd: bigint;
  pricingComplete: boolean;
  minimumPercentDelta?: number;
  planShares?: Record<string, number>;
}): QuotaSampleResult {
  if (input.previousResetsAt !== input.currentResetsAt) {
    return { accepted: false, reason: "window_reset" };
  }
  if (!input.pricingComplete) {
    return { accepted: false, reason: "incomplete_pricing" };
  }
  const delta = input.currentUsedPercent - input.previousUsedPercent;
  if (delta < 0) {
    return { accepted: false, reason: "percentage_decreased" };
  }
  if (delta < (input.minimumPercentDelta ?? 1)) {
    return { accepted: false, reason: "percentage_delta_too_small" };
  }
  if (input.observedNanoUsd <= BigInt(0)) {
    return { accepted: false, reason: "missing_usage" };
  }
  const planShares = quotaSharesForPlan(input.planType, input.planShares);
  const deltaThousandths = BigInt(Math.round(delta * 1000));
  const credentialCapacity =
    (input.observedNanoUsd * BigInt(100_000)) / deltaThousandths;
  return {
    accepted: true,
    perShareNanoUsd: credentialCapacity / BigInt(planShares),
    percentSpan: delta,
    planShares,
  };
}

export interface AcceptedCalibrationSample {
  perShareNanoUsd: bigint;
  credentialId: string;
  percentSpan: number;
  observedAt: string;
}

export function deriveQuotaBaseline(samples: AcceptedCalibrationSample[]) {
  if (samples.length === 0) {
    return { valueNanoUsd: null, sampleCount: 0, confidence: 0 };
  }
  // Upstream percentages are quantized, so a capacity calculated from one
  // small movement is inherently noisy. Collapse all movements from the same
  // credential first: weighting by percent span is equivalent to estimating
  // capacity from its cumulative priced cost / cumulative percentage movement.
  // It also prevents one frequently-polled credential from dominating merely
  // because it produced more adjacent samples.
  const credentialSamples = aggregateCredentialSamples(samples);
  const center = median(credentialSamples.map((sample) => sample.perShareNanoUsd));
  const deviations = credentialSamples.map((sample) => absolute(sample.perShareNanoUsd - center));
  const mad = median(deviations);
  const threshold = mad === BigInt(0) ? center / BigInt(10) : mad * BigInt(3);
  const filtered = credentialSamples.filter(
    (sample) => absolute(sample.perShareNanoUsd - center) <= threshold,
  );
  const valueNanoUsd = weightedMedian(filtered);
  const credentials = filtered.length;
  const span = filtered.reduce((total, sample) => total + sample.percentSpan, 0);
  const contributingSamples = filtered.reduce((total, sample) => total + sample.sampleCount, 0);
  const confidence = Math.min(
    1,
    contributingSamples / 12 + credentials / 8 + Math.min(span, 100) / 400,
  );
  return {
    valueNanoUsd,
    sampleCount: contributingSamples,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

type AggregatedCalibrationSample = AcceptedCalibrationSample & { sampleCount: number };

function aggregateCredentialSamples(samples: AcceptedCalibrationSample[]): AggregatedCalibrationSample[] {
  const groups = new Map<string, AcceptedCalibrationSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.credentialId) || [];
    group.push(sample);
    groups.set(sample.credentialId, group);
  }
  return [...groups.entries()].map(([credentialId, group]) => {
    const span = group.reduce((total, sample) => total + Math.max(sample.percentSpan, 0.001), 0);
    const scale = 1_000;
    const weightedTotal = group.reduce(
      (total, sample) =>
        total + sample.perShareNanoUsd * BigInt(Math.max(1, Math.round(sample.percentSpan * scale))),
      BigInt(0),
    );
    const weight = group.reduce(
      (total, sample) => total + BigInt(Math.max(1, Math.round(sample.percentSpan * scale))),
      BigInt(0),
    );
    return {
      credentialId,
      perShareNanoUsd: weightedTotal / weight,
      percentSpan: span,
      observedAt: group.reduce(
        (latest, sample) => (sample.observedAt > latest ? sample.observedAt : latest),
        group[0].observedAt,
      ),
      sampleCount: group.length,
    };
  });
}

export function quotaSharesForPlan(planType: string, overrides?: Record<string, number>) {
  const plan = String(planType || "").trim().toLowerCase();
  const configured = overrides?.[plan];
  if (configured && Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return codexPlanShares(planType);
}

function weightedMedian(samples: AggregatedCalibrationSample[]) {
  const sorted = [...samples].sort((left, right) =>
    left.perShareNanoUsd < right.perShareNanoUsd ? -1 : 1,
  );
  // Cap each credential's influence: larger spans are better evidence, but no
  // single account should be able to define the global baseline on its own.
  const weightOf = (sample: AggregatedCalibrationSample) =>
    Math.sqrt(Math.min(Math.max(sample.percentSpan, 0.001), 100));
  const totalWeight = sorted.reduce((total, sample) => total + weightOf(sample), 0);
  let cursor = 0;
  for (const sample of sorted) {
    cursor += weightOf(sample);
    if (cursor >= totalWeight / 2) return sample.perShareNanoUsd;
  }
  return sorted.at(-1)!.perShareNanoUsd;
}

function median(values: bigint[]) {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : 1));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / BigInt(2);
}

function absolute(value: bigint) {
  return value < BigInt(0) ? -value : value;
}

const CALIBRATION_STATE_KEY = "quota_calibration_state_v1";

type PersistedCalibrationState = {
  credentialUsage: Record<string, { totalNanoUsd: string; unpricedRequests: number }>;
  observations: Record<string, { usedPercent: number; resetsAt: string; totalNanoUsd: string; unpricedRequests: number }>;
  samples: Record<"5h" | "7d", Array<{ perShareNanoUsd: string; credentialId: string; percentSpan: number; observedAt: string }>>;
  baselines: Record<"5h" | "7d", { automaticNanoUsd: string | null; overrideNanoUsd: string | null; confidence: number; sampleCount: number }>;
  oversellRatios: Record<"5h" | "7d", number>;
  credentialOverrides: Record<string, Partial<Record<"5h" | "7d", string | null>>>;
};

export function recordCredentialPricedUsage(
  credentialId: string,
  costNanoUsd: bigint,
  pricingComplete: boolean,
) {
  const state = readState();
  const usage = state.credentialUsage[credentialId] || {
    totalNanoUsd: "0",
    unpricedRequests: 0,
  };
  usage.totalNanoUsd = String(BigInt(usage.totalNanoUsd) + costNanoUsd);
  if (!pricingComplete) usage.unpricedRequests += 1;
  state.credentialUsage[credentialId] = usage;
  writeState(state);
}

export function recordCodexQuotaObservation(input: {
  credentialId: string;
  planType: string;
  observedAt: string;
  windows: Array<{ kind: "5h" | "7d"; usedPercent: number | null; resetsAt: string | null }>;
}) {
  const state = readState();
  const usage = state.credentialUsage[input.credentialId] || {
    totalNanoUsd: "0",
    unpricedRequests: 0,
  };
  const results: Array<{ kind: "5h" | "7d"; result: QuotaSampleResult }> = [];
  for (const window of input.windows) {
    if (window.usedPercent === null || !window.resetsAt) continue;
    const key = `${input.credentialId}:${window.kind}`;
    const previous = state.observations[key];
    if (previous) {
      const result = estimateQuotaSample({
        planType: input.planType,
        previousUsedPercent: previous.usedPercent,
        currentUsedPercent: window.usedPercent,
        previousResetsAt: previous.resetsAt,
        currentResetsAt: window.resetsAt,
        observedNanoUsd:
          BigInt(usage.totalNanoUsd) - BigInt(previous.totalNanoUsd),
        pricingComplete: usage.unpricedRequests === previous.unpricedRequests,
      });
      results.push({ kind: window.kind, result });
      if (result.accepted) {
        state.samples[window.kind].push({
          perShareNanoUsd: String(result.perShareNanoUsd),
          credentialId: input.credentialId,
          percentSpan: result.percentSpan,
          observedAt: input.observedAt,
        });
        state.samples[window.kind] = state.samples[window.kind].slice(-100);
        const baseline = deriveQuotaBaseline(
          state.samples[window.kind].map((sample) => ({
            ...sample,
            perShareNanoUsd: BigInt(sample.perShareNanoUsd),
          })),
        );
        state.baselines[window.kind].automaticNanoUsd =
          baseline.valueNanoUsd === null ? null : String(baseline.valueNanoUsd);
        state.baselines[window.kind].confidence = baseline.confidence;
        state.baselines[window.kind].sampleCount = baseline.sampleCount;
      }
    }
    state.observations[key] = {
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      totalNanoUsd: usage.totalNanoUsd,
      unpricedRequests: usage.unpricedRequests,
    };
  }
  writeState(state);
  return results;
}

export function getEffectiveQuotaBaselines() {
  const state = readState();
  return Object.fromEntries(
    (["5h", "7d"] as const).map((kind) => {
      const row = state.baselines[kind];
      const effective = row.overrideNanoUsd || row.automaticNanoUsd;
      return [kind, {
        automaticNanoUsd: row.automaticNanoUsd === null ? null : BigInt(row.automaticNanoUsd),
        overrideNanoUsd: row.overrideNanoUsd === null ? null : BigInt(row.overrideNanoUsd),
        effectiveNanoUsd: effective === null ? null : BigInt(effective),
        confidence: row.confidence,
        sampleCount: row.sampleCount,
      }];
    }),
  ) as Record<"5h" | "7d", { automaticNanoUsd: bigint | null; overrideNanoUsd: bigint | null; effectiveNanoUsd: bigint | null; confidence: number; sampleCount: number }>;
}

export function getCredentialQuotaEstimates(credentialId: string, planType: string) {
  const state = readState();
  const shares = BigInt(quotaSharesForPlan(planType));
  return Object.fromEntries((["5h", "7d"] as const).map((kind) => {
    const automatic = deriveQuotaBaseline(state.samples[kind]
      .filter((sample) => sample.credentialId === credentialId)
      .map((sample) => ({ ...sample, perShareNanoUsd: BigInt(sample.perShareNanoUsd) })));
    const automaticNanoUsd = automatic.valueNanoUsd === null ? null : automatic.valueNanoUsd * shares;
    const override = state.credentialOverrides[credentialId]?.[kind] ?? null;
    return [kind, {
      automaticNanoUsd,
      overrideNanoUsd: override === null ? null : BigInt(override),
      effectiveNanoUsd: override === null ? automaticNanoUsd : BigInt(override),
      confidence: automatic.confidence,
      sampleCount: automatic.sampleCount,
    }];
  })) as Record<"5h" | "7d", { automaticNanoUsd: bigint | null; overrideNanoUsd: bigint | null; effectiveNanoUsd: bigint | null; confidence: number; sampleCount: number }>;
}

export function setCredentialQuotaEstimates(
  credentialId: string,
  values: Partial<Record<"5h" | "7d", bigint | null>>,
) {
  const state = readState();
  const current = state.credentialOverrides[credentialId] || {};
  for (const kind of ["5h", "7d"] as const) {
    if (Object.hasOwn(values, kind)) current[kind] = values[kind] === null ? null : String(values[kind]);
  }
  state.credentialOverrides[credentialId] = current;
  writeState(state);
}

export function setQuotaBaselineOverride(
  kind: "5h" | "7d",
  valueNanoUsd: bigint | null,
) {
  const state = readState();
  state.baselines[kind].overrideNanoUsd =
    valueNanoUsd === null ? null : String(valueNanoUsd);
  writeState(state);
  return getEffectiveQuotaBaselines()[kind];
}

export function getQuotaOversellRatios() {
  return readState().oversellRatios;
}

export function setQuotaOversellRatio(kind: "5h" | "7d", ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1000) {
    throw new Error(`${kind} oversell ratio must be between 0 and 1000`);
  }
  const state = readState();
  state.oversellRatios[kind] = Math.round(ratio * 1000) / 1000;
  writeState(state);
  return state.oversellRatios[kind];
}

function readState(): PersistedCalibrationState {
  const empty: PersistedCalibrationState = {
    credentialUsage: {},
    observations: {},
    samples: { "5h": [], "7d": [] },
    baselines: {
      "5h": { automaticNanoUsd: null, overrideNanoUsd: null, confidence: 0, sampleCount: 0 },
      "7d": { automaticNanoUsd: null, overrideNanoUsd: null, confidence: 0, sampleCount: 0 },
    },
    oversellRatios: { "5h": 1, "7d": 1 },
    credentialOverrides: {},
  };
  const raw = getSettingValue(CALIBRATION_STATE_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCalibrationState>;
    return {
      ...empty,
      ...parsed,
      credentialUsage: parsed.credentialUsage || {},
      observations: parsed.observations || {},
      samples: { ...empty.samples, ...(parsed.samples || {}) },
      baselines: { ...empty.baselines, ...(parsed.baselines || {}) },
      oversellRatios: { ...empty.oversellRatios, ...(parsed.oversellRatios || {}) },
      credentialOverrides: parsed.credentialOverrides || {},
    };
  } catch {
    return empty;
  }
}

function writeState(state: PersistedCalibrationState) {
  upsertSettingValue(CALIBRATION_STATE_KEY, JSON.stringify(state));
}
import "server-only";

import {
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
