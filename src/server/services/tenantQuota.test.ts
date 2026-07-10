import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import type { HttpError } from "@/src/server/http/errors";

type Module = typeof import("@/src/server/services/tenantQuota");
type Tenants = typeof import("@/src/server/services/tenants");
type Calibration = typeof import("@/src/server/services/quotaCalibration");

let quota: Module;
let tenants: Tenants;
let calibration: Calibration;
let tenantId: string;

describe("tenant quota service", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tenant-quota-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    quota = await import("@/src/server/services/tenantQuota");
    tenants = await import("@/src/server/services/tenants");
    calibration = await import("@/src/server/services/quotaCalibration");
    tenantId = tenants.createTenant({ name: "Limited", ownerEmail: "limited@example.com", quotaShares: 3 }).id;
    calibration.setQuotaBaselineOverride("5h", BigInt(1_000_000));
    calibration.setQuotaBaselineOverride("7d", BigInt(10_000_000));
  });

  test("applies shares to both baselines and emits stable headers", () => {
    const admission = quota.admitTenantRequest({ tenantId, requestId: "admit-1", model: "gpt-5.6-terra", now: new Date("2026-07-10T12:00:00Z") });
    expect(admission.state?.windows["5h"].limitNanoUsd).toBe(BigInt(3_000_000));
    expect(quota.tenantQuotaHeaders(admission.state!, 3)).toMatchObject({
      "x-relay-quota-shares": "3",
      "x-relay-quota-5h-limit-nanousd": "3000000",
    });
  });

  test("returns a Codex-style rate limit error with reset metadata", () => {
    quota.settleTenantRequest({ requestId: "admit-1", actualNanoUsd: BigInt(3_000_000) });
    try {
      quota.admitTenantRequest({ tenantId, requestId: "admit-2", model: "gpt-5.6-terra", now: new Date("2026-07-10T12:01:00Z") });
      throw new Error("expected quota error");
    } catch (error) {
      const quotaError = error as HttpError;
      expect(quotaError.status).toBe(429);
      expect(quotaError.code).toBe("tenant_quota_exceeded");
      expect(quotaError.details).toMatchObject({ type: "rate_limit_error", window: "5h", remaining: "0" });
    }
  });
});
