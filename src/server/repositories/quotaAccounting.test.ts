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
  test("calibrates settled usage without changing reset boundaries or reservations", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    quota.reserveSubscriptionQuota({ requestId: "r4", subscriptionId: "sub3", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-18T00:00:00Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    const state = quota.calibrateSubscriptionQuota("sub3", { "5h": { startedAt: "2026-07-10T19:00:00Z", settledNanoUsd: 20n }, "7d": { startedAt: "2026-07-04T00:00:00Z", settledNanoUsd: 70n } });
    expect(state.windows["5h"]).toMatchObject({ settledNanoUsd: 20n, reservedNanoUsd: 10n, resetsAt: "2026-07-11T05:00:00Z" });
    expect(state.windows["7d"]).toMatchObject({ settledNanoUsd: 70n, reservedNanoUsd: 10n, resetsAt: "2026-07-18T00:00:00Z" });
  });
  test("does not reset usage when a stale upstream boundary moves backwards", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    quota.reserveSubscriptionQuota({ requestId: "r5", subscriptionId: "sub4", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-18T00:00:00Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    quota.settleSubscriptionQuota({ requestId: "r5", actualNanoUsd: 7n });
    quota.reserveSubscriptionQuota({ requestId: "r6", subscriptionId: "sub4", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T04:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-17T00:00:00Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    expect(quota.getSubscriptionQuotaState("sub4").windows["5h"]).toMatchObject({ resetsAt: "2026-07-11T05:00:00Z", settledNanoUsd: 7n, reservedNanoUsd: 10n });
    expect(quota.getSubscriptionQuotaState("sub4").windows["7d"]).toMatchObject({ resetsAt: "2026-07-18T00:00:00Z", settledNanoUsd: 7n, reservedNanoUsd: 10n });
  });
  test("treats equivalent reset timestamps as the same window", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    quota.reserveSubscriptionQuota({ requestId: "r7", subscriptionId: "sub5", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00.000Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-18T00:00:00.000Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    quota.settleSubscriptionQuota({ requestId: "r7", actualNanoUsd: 7n });
    quota.reserveSubscriptionQuota({ requestId: "r8", subscriptionId: "sub5", reserveNanoUsd: 10n, windows: { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-11T05:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-18T00:00:00Z" } }, now, expiresAt: new Date(now.getTime() + 1000) });
    expect(quota.getSubscriptionQuotaState("sub5").windows["5h"]).toMatchObject({ settledNanoUsd: 7n, reservedNanoUsd: 10n });
  });
  test("synchronizes a new upstream boundary to every initialized subscription", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const windows = { "5h": { limitNanoUsd: 100n, resetsAt: "2026-07-15T05:00:00Z" }, "7d": { limitNanoUsd: 1000n, resetsAt: "2026-07-15T00:00:00Z" } };
    for (const [index, subscriptionId] of ["sub6", "sub7"].entries()) {
      quota.reserveSubscriptionQuota({ requestId: `sync-${index}`, subscriptionId, reserveNanoUsd: 10n, windows, now: new Date("2026-07-14T23:00:00Z"), expiresAt: new Date("2026-07-15T01:00:00Z") });
      quota.settleSubscriptionQuota({ requestId: `sync-${index}`, actualNanoUsd: 7n });
    }

    expect(quota.synchronizeSubscriptionQuotaWindows(["sub6", "sub7"], { "7d": "2026-07-22T00:00:00Z" }, now)).toBe(2);
    for (const subscriptionId of ["sub6", "sub7"]) {
      expect(quota.getSubscriptionQuotaState(subscriptionId).windows["7d"]).toMatchObject({
        startedAt: "2026-07-15T00:00:00.000Z",
        resetsAt: "2026-07-22T00:00:00Z",
        settledNanoUsd: 0n,
        reservedNanoUsd: 0n,
      });
    }
    expect(quota.synchronizeSubscriptionQuotaWindows(["sub6", "sub7"], { "7d": "2026-07-21T00:00:00Z" }, now)).toBe(0);
  });
});
