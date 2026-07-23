import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

let events: typeof import("@/src/server/repositories/credentialQuotaResetEvents");

describe("credential quota reset events", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reset-events-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    events = await import("@/src/server/repositories/credentialQuotaResetEvents");
  });

  test("stores natural and redeemed resets newest first", () => {
    events.insertCredentialQuotaResetEvent({ credentialId: "cred-1", windowKind: "5h", source: "natural", previousResetsAt: "2026-07-16T05:00:00Z", nextResetsAt: "2026-07-16T10:00:00Z", previousUsedPercent: 82, windowsReset: 1, occurredAt: "2026-07-16T05:00:01Z" });
    events.insertCredentialQuotaResetEvent({ credentialId: "cred-1", windowKind: "all", source: "reset_credit", previousResetsAt: null, nextResetsAt: null, previousUsedPercent: null, windowsReset: 2, occurredAt: "2026-07-16T06:00:00Z" });
    expect(events.listCredentialQuotaResetEvents("cred-1").map((item) => item.source)).toEqual(["reset_credit", "natural"]);
    expect(events.hasRecentResetCreditEvent("cred-1", "2026-07-16T05:59:00Z")).toBe(true);
    expect(events.hasRecentResetCreditEvent("cred-1", "2026-07-16T06:01:00Z")).toBe(false);
  });

  test("records a natural reset for any provider credential only when the boundary advances", () => {
    const reset = events.recordNaturalCredentialQuotaReset({
      credentialId: "grok-cred-1",
      windowKind: "7d",
      previousResetsAt: "2026-07-16T03:25:00Z",
      nextResetsAt: "2026-07-23T03:25:00Z",
      previousUsedPercent: 64,
      occurredAt: "2026-07-16T03:25:01Z",
    });
    expect(reset).toMatchObject({
      credentialId: "grok-cred-1",
      windowKind: "7d",
      source: "natural",
      previousUsedPercent: 64,
    });
    expect(
      events.recordNaturalCredentialQuotaReset({
        credentialId: "grok-cred-1",
        windowKind: "7d",
        previousResetsAt: "2026-07-23T03:25:00Z",
        nextResetsAt: "2026-07-23T03:25:30Z",
        previousUsedPercent: 0,
        occurredAt: "2026-07-16T03:25:02Z",
      }),
    ).toBeNull();
  });
});
