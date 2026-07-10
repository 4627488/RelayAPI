import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type LogsRepository = typeof import("@/src/server/repositories/logs");
type SettingsService = typeof import("@/src/server/services/settings");
type RebuildService = typeof import("@/src/server/services/timeZoneRebuild");

let logs: LogsRepository;
let settings: SettingsService;
let rebuild: RebuildService;
let logDbPath: string;

describe("timezone aggregate rebuild", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tz-rebuild-"));
    logDbPath = path.join(dir, "log.sqlite");
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = logDbPath;
    logs = await import("@/src/server/repositories/logs");
    settings = await import("@/src/server/services/settings");
    rebuild = await import("@/src/server/services/timeZoneRebuild");
  });

  it("rebuilds request and usage buckets before activating the pending zone", async () => {
    appendLog("2026-07-10T03:59:59.000Z");
    appendLog("2026-07-10T04:00:00.000Z");
    settings.patchGlobalSettings({ timeZone: "America/New_York" });

    await rebuild.runPendingTimeZoneRebuild();

    expect(settings.getTimeZoneRebuildState()).toEqual({
      timeZone: "America/New_York",
      timeZonePending: null,
      timeZoneRebuildStatus: "idle",
      timeZoneRebuildError: null,
    });
    const database = new Database(logDbPath, { readonly: true });
    const requestDates = database
      .prepare("SELECT bucket_date FROM request_daily_buckets ORDER BY bucket_date")
      .all()
      .map((row) => (row as { bucket_date: string }).bucket_date);
    const usageDates = database
      .prepare("SELECT bucket_date FROM usage_daily_buckets ORDER BY bucket_date")
      .all()
      .map((row) => (row as { bucket_date: string }).bucket_date);
    database.close();
    expect(requestDates).toEqual(["2026-07-09", "2026-07-10"]);
    expect(usageDates).toEqual(["2026-07-09", "2026-07-10"]);
  });
});

function appendLog(startedAt: string) {
  logs.appendRequestLog({
    startedAt,
    completedAt: startedAt,
    method: "POST",
    path: "/v1/responses",
    requestType: "responses",
    stream: false,
    model: "gpt-5-codex",
    statusCode: 200,
    latencyMs: 10,
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cachedTokens: 0,
    },
  });
}
