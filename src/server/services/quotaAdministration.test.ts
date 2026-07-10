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
      baselines: { "5h": "1000000", "7d": "9000000" },
      aliases: { "custom-terra": "gpt-5.6-terra" },
      overrides: {
        "gpt-5.6-terra": {
          inputNanoUsdPerToken: "3000",
          outputNanoUsdPerToken: "16000",
          cachedInputNanoUsdPerToken: "300",
        },
      },
    });
    expect(service.getQuotaAdministration().baselines["5h"].effectiveNanoUsd).toBe("1000000");
    expect(service.resolveConfiguredModelPrice("custom-terra")).toMatchObject({
      source: "admin",
      inputNanoUsdPerToken: BigInt(3000),
      outputNanoUsdPerToken: BigInt(16000),
    });
  });
});
