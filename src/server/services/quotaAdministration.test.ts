import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

type Service = typeof import("@/src/server/services/quotaAdministration");
let service: Service;

describe("quota administration", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-quota-admin-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    service = await import("@/src/server/services/quotaAdministration");
  });

  test("persists baseline and model price overrides", () => {
    service.patchQuotaAdministration({
      providers: {
        codex: {
          "5h": { overrideNanoUsd: "1000000" },
          "7d": { overrideNanoUsd: "9000000" },
        },
        grok: {
          "7d": { overrideNanoUsd: "2000000" },
        },
      },
      aliases: { "custom-terra": "gpt-5.6-terra" },
      overrides: {
        "gpt-5.6-terra": {
          inputNanoUsdPerToken: "3000",
          outputNanoUsdPerToken: "16000",
          cachedInputNanoUsdPerToken: "300",
        },
      },
    });
    const quota = service.getQuotaAdministration();
    expect(quota.providers.codex["5h"].effectiveNanoUsd).toBe("1000000");
    expect(quota.providers.grok["7d"].effectiveNanoUsd).toBe("2000000");
    expect(quota.providers.grok["5h"].effectiveNanoUsd).toBeNull();
    expect(service.resolveConfiguredModelPrice("custom-terra")).toMatchObject({
      source: "admin",
      inputNanoUsdPerToken: BigInt(3000),
      outputNanoUsdPerToken: BigInt(16000),
    });
  });

  test("updates and deletes existing custom model prices", () => {
    service.patchQuotaAdministration({
      overrides: {
        "editable-model": {
          inputNanoUsdPerToken: "1000",
          outputNanoUsdPerToken: "2000",
        },
      },
    });
    expect(service.resolveConfiguredModelPrice("editable-model")).toMatchObject({
      source: "admin",
      inputNanoUsdPerToken: 1000n,
      outputNanoUsdPerToken: 2000n,
    });

    const updated = service.patchQuotaAdministration({
      overrides: {
        "editable-model": {
          inputNanoUsdPerToken: "3000",
          outputNanoUsdPerToken: "4000",
          cachedInputNanoUsdPerToken: "500",
        },
      },
    });
    expect(updated.pricing.overrides).toEqual([
      expect.objectContaining({
        model: "editable-model",
        inputNanoUsdPerToken: "3000",
        outputNanoUsdPerToken: "4000",
        cachedInputNanoUsdPerToken: "500",
      }),
    ]);

    const deleted = service.patchQuotaAdministration({ overrides: {} });
    expect(deleted.pricing.overrides).toEqual([]);
    expect(service.resolveConfiguredModelPrice("editable-model")).toBeNull();
  });
});
