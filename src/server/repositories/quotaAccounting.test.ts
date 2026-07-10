import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

type Repository = typeof import("@/src/server/repositories/quotaAccounting");
type Tenants = typeof import("@/src/server/services/tenants");

let repository: Repository;
let tenants: Tenants;
let tenantId: string;

describe("quota accounting repository", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-quota-accounting-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    repository = await import("@/src/server/repositories/quotaAccounting");
    tenants = await import("@/src/server/services/tenants");
    tenantId = tenants.createTenant({ name: "Quota tenant", ownerEmail: "quota@example.com" }).id;
  });

  test("reserves both windows atomically and rejects capacity contention", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const first = repository.reserveTenantQuota({
      requestId: "request-1",
      tenantId,
      reserveNanoUsd: 600n,
      limitsNanoUsd: { "5h": 1_000n, "7d": 10_000n },
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect(first.windows["5h"].reservedNanoUsd).toBe(600n);

    expect(() =>
      repository.reserveTenantQuota({
        requestId: "request-2",
        tenantId,
        reserveNanoUsd: 500n,
        limitsNanoUsd: { "5h": 1_000n, "7d": 10_000n },
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ).toThrowError(repository.TenantQuotaCapacityError);

    expect(repository.getTenantQuotaState(tenantId).windows["5h"].reservedNanoUsd).toBe(600n);
  });

  test("settles a reservation once and rolls expired fixed windows", () => {
    repository.settleTenantQuota({ requestId: "request-1", actualNanoUsd: 750n });
    repository.settleTenantQuota({ requestId: "request-1", actualNanoUsd: 900n });
    expect(repository.getTenantQuotaState(tenantId).windows["5h"]).toMatchObject({
      settledNanoUsd: 750n,
      reservedNanoUsd: 0n,
    });

    const later = new Date("2026-07-10T17:00:01.000Z");
    const next = repository.reserveTenantQuota({
      requestId: "request-3",
      tenantId,
      reserveNanoUsd: 100n,
      limitsNanoUsd: { "5h": 1_000n, "7d": 10_000n },
      now: later,
      expiresAt: new Date(later.getTime() + 60_000),
    });
    expect(next.windows["5h"]).toMatchObject({
      settledNanoUsd: 0n,
      reservedNanoUsd: 100n,
    });
    expect(next.windows["7d"].settledNanoUsd).toBe(750n);
  });

  test("reclaims expired reservations during maintenance", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    repository.reserveTenantQuota({ requestId: "expired-1", tenantId, reserveNanoUsd: BigInt(10), limitsNanoUsd: { "5h": BigInt(1000), "7d": BigInt(10000) }, now, expiresAt: new Date(now.getTime() + 1000) });
    expect(repository.reclaimExpiredQuotaReservations(new Date(now.getTime() + 2000))).toBe(1);
  });
});
