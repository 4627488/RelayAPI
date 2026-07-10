import { describe, expect, test } from "vitest";

import {
  deriveQuotaBaseline,
  estimateQuotaSample,
} from "@/src/server/services/quotaCalibration";

describe("quota calibration", () => {
  test("normalizes credential capacity by subscription shares", () => {
    const plus = estimateQuotaSample({
      planType: "plus", previousUsedPercent: 10, currentUsedPercent: 20,
      previousResetsAt: "2026-07-11T00:00:00Z", currentResetsAt: "2026-07-11T00:00:00Z",
      observedNanoUsd: BigInt(1_000), pricingComplete: true,
    });
    const pro = estimateQuotaSample({
      planType: "pro", previousUsedPercent: 10, currentUsedPercent: 20,
      previousResetsAt: "2026-07-11T00:00:00Z", currentResetsAt: "2026-07-11T00:00:00Z",
      observedNanoUsd: BigInt(20_000), pricingComplete: true,
    });
    expect(plus).toMatchObject({ accepted: true, perShareNanoUsd: BigInt(10_000) });
    expect(pro).toMatchObject({ accepted: true, perShareNanoUsd: BigInt(10_000) });
  });

  test("rejects reset boundaries, incomplete pricing, and tiny deltas", () => {
    expect(estimateQuotaSample({ planType: "pro", previousUsedPercent: 10, currentUsedPercent: 20, previousResetsAt: "a", currentResetsAt: "b", observedNanoUsd: BigInt(10), pricingComplete: true })).toMatchObject({ accepted: false, reason: "window_reset" });
    expect(estimateQuotaSample({ planType: "pro", previousUsedPercent: 10, currentUsedPercent: 20, previousResetsAt: "a", currentResetsAt: "a", observedNanoUsd: BigInt(10), pricingComplete: false })).toMatchObject({ accepted: false, reason: "incomplete_pricing" });
    expect(estimateQuotaSample({ planType: "pro", previousUsedPercent: 10, currentUsedPercent: 10.4, previousResetsAt: "a", currentResetsAt: "a", observedNanoUsd: BigInt(10), pricingComplete: true })).toMatchObject({ accepted: false, reason: "percentage_delta_too_small" });
  });

  test("uses a robust median and reports confidence", () => {
    const result = deriveQuotaBaseline([
      { perShareNanoUsd: BigInt(9_500), credentialId: "a", percentSpan: 10, observedAt: "2026-07-10T00:00:00Z" },
      { perShareNanoUsd: BigInt(10_000), credentialId: "b", percentSpan: 20, observedAt: "2026-07-10T01:00:00Z" },
      { perShareNanoUsd: BigInt(10_500), credentialId: "c", percentSpan: 10, observedAt: "2026-07-10T02:00:00Z" },
      { perShareNanoUsd: BigInt(1_000_000), credentialId: "d", percentSpan: 10, observedAt: "2026-07-10T03:00:00Z" },
    ]);
    expect(result.valueNanoUsd).toBe(BigInt(10_000));
    expect(result.sampleCount).toBe(3);
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});
