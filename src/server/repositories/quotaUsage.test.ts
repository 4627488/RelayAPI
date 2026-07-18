import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

type LogsRepository = typeof import("@/src/server/repositories/logs");
type QuotaUsageRepository = typeof import("@/src/server/repositories/quotaUsage");

let logs: LogsRepository;
let quotaUsage: QuotaUsageRepository;

describe("quota usage repository", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-quota-usage-test-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    logs = await import("@/src/server/repositories/logs");
    quotaUsage = await import("@/src/server/repositories/quotaUsage");
  });

  test("counts daily tokens independently for API keys and tenants", async () => {
    logs.appendRequestLog({
      startedAt: "2026-07-18T01:00:00.000Z",
      method: "POST",
      path: "/v1/responses",
      requestType: "responses",
      stream: false,
      statusCode: 200,
      latencyMs: 10,
      apiKeyId: "key-a",
      tenantId: "tenant-a",
      usage: {
        promptTokens: 7,
        completionTokens: 5,
        totalTokens: 12,
        cachedTokens: 0,
      },
    });
    await logs.flushRequestLogWrites();

    const day = new Date("2026-07-18T12:00:00.000Z");
    expect(quotaUsage.getApiKeyDailyUsage("key-a", day)).toBe(12);
    expect(quotaUsage.getTenantDailyUsage("tenant-a", day)).toBe(12);
    expect(quotaUsage.getApiKeyDailyUsage("key-b", day)).toBe(0);
  });

  test("counts recent requests by subject", () => {
    expect(
      quotaUsage.getApiKeyRequestCountSince(
        "key-a",
        new Date("2026-07-18T00:59:00.000Z"),
      ),
    ).toBe(1);
    expect(
      quotaUsage.getTenantRequestCountSince(
        "tenant-a",
        new Date("2026-07-18T01:01:00.000Z"),
      ),
    ).toBe(0);
  });
});
