import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type SettingsService = typeof import("@/src/server/services/settings");

let settings: SettingsService;

describe("global timezone settings", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-settings-test-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    settings = await import("@/src/server/services/settings");
  });

  it("defaults to Asia/Shanghai", () => {
    expect(settings.getGlobalTimeZoneSetting()).toBe("Asia/Shanghai");
    expect(settings.getPublicGlobalSettings()).toMatchObject({
      timeZone: "Asia/Shanghai",
      timeZonePending: null,
      timeZoneRebuildStatus: "idle",
      timeZoneRebuildError: null,
    });
  });

  it("stores a valid timezone as pending without changing the active zone", () => {
    const result = settings.patchGlobalSettings({
      timeZone: "America/New_York",
    });
    expect(result).toMatchObject({
      timeZone: "Asia/Shanghai",
      timeZonePending: "America/New_York",
      timeZoneRebuildStatus: "pending",
      timeZoneRebuildError: null,
    });
  });

  it("rejects invalid IANA timezone identifiers", () => {
    expect(() => settings.patchGlobalSettings({ timeZone: "Mars/Olympus" }))
      .toThrowError(/valid IANA timezone/);
  });

  it("normalizes and validates the public website URL", () => {
    expect(settings.normalizePublicBaseUrl("https://relay.example.com///"))
      .toBe("https://relay.example.com");
    expect(settings.normalizePublicBaseUrl("")) .toBe("");
    expect(() => settings.normalizePublicBaseUrl("ftp://relay.example.com"))
      .toThrowError(/HTTP/);
  });
});
