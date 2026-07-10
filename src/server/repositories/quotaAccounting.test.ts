import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

let quota: typeof import("@/src/server/repositories/quotaAccounting");
describe("subscription quota accounting", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-subscription-quota-"));
    process.env.DATA_DIR = dir; process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite"); process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    quota = await import("@/src/server/repositories/quotaAccounting");
  });
  test("inherits upstream resets and settles one subscription", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    quota.reserveSubscriptionQuota({ requestId: "r1", subscriptionId: "sub1", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-18T00:00:00Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    quota.settleSubscriptionQuota({ requestId: "r1", actualNanoUsd: 7n });
    expect(quota.getSubscriptionQuotaState("sub1").windows["5h"]).toMatchObject({ resetsAt: "2026-07-11T05:00:00Z", settledNanoUsd: 7n });
  });
  test("rejects exhausted subscriptions", () => {
    const base = { subscriptionId: "sub2", reserveNanoUsd: 60n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00Z" }, "7d": { limitNanoUsd: 100n, resetsAt: "2026-07-18T00:00:00Z" } }, now: new Date("2026-07-11T00:00:00Z"), expiresAt: new Date("2026-07-11T01:00:00Z") };
    quota.reserveSubscriptionQuota({ ...base, requestId: "r2" });
    expect(() => quota.reserveSubscriptionQuota({ ...base, requestId: "r3" })).toThrow(quota.SubscriptionQuotaCapacityError);
  });
});
