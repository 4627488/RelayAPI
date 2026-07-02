import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

type LogsRepository = typeof import("@/src/server/repositories/logs");

let logs: LogsRepository;

describe("queryRequestLogs", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-logs-test-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    logs = await import("@/src/server/repositories/logs");
  });

  test("matches full request log detail bodies when summary fields do not match", () => {
    const id = logs.appendRequestLog({
      startedAt: "2026-07-02T00:00:00.000Z",
      completedAt: "2026-07-02T00:00:01.000Z",
      method: "POST",
      path: "/v1/responses",
      requestType: "responses",
      stream: false,
      model: "gpt-5-codex",
      statusCode: 200,
      latencyMs: 123,
      tenantId: "tenant-a",
    });
    logs.appendRequestLogDetail(id, {
      requestBodyText: '{"input":"needle in original body"}',
      forwardedBodyText: '{"input":"needle in forwarded body"}',
      upstreamBodyText: '{"output_text":"needle in upstream body"}',
      errorMessage: "needle in detail error",
      errorStack: "Error: needle in stack",
      detail: { note: "needle in detail json" },
      stageTimings: [
        {
          stage: "stage-only-token",
          label: "Stage only",
          durationMs: 1,
        },
      ],
    });

    const result = logs.queryRequestLogs({
      query: "needle in forwarded body",
      tenantId: "tenant-a",
    });

    expect(result.total).toBe(1);
    expect(result.data[0]?.id).toBe(id);
  });

  test("keeps detail body search tenant scoped", () => {
    const tenantAId = logs.appendRequestLog({
      startedAt: "2026-07-02T00:01:00.000Z",
      completedAt: "2026-07-02T00:01:01.000Z",
      method: "POST",
      path: "/v1/chat/completions",
      requestType: "chat.completions",
      stream: false,
      model: "gpt-5-codex",
      statusCode: 200,
      latencyMs: 100,
      tenantId: "tenant-a",
    });
    logs.appendRequestLogDetail(tenantAId, {
      requestBodyText: "shared-body-needle",
    });
    const tenantBId = logs.appendRequestLog({
      startedAt: "2026-07-02T00:02:00.000Z",
      completedAt: "2026-07-02T00:02:01.000Z",
      method: "POST",
      path: "/v1/chat/completions",
      requestType: "chat.completions",
      stream: false,
      model: "gpt-5-codex",
      statusCode: 200,
      latencyMs: 100,
      tenantId: "tenant-b",
    });
    logs.appendRequestLogDetail(tenantBId, {
      requestBodyText: "shared-body-needle",
    });

    const result = logs.queryRequestLogs({
      query: "shared-body-needle",
      tenantId: "tenant-a",
    });

    expect(result.data.map((row) => row.id)).toEqual([tenantAId]);
  });

  test("does not include stage timing JSON in normal body search", () => {
    const id = logs.appendRequestLog({
      startedAt: "2026-07-02T00:03:00.000Z",
      completedAt: "2026-07-02T00:03:01.000Z",
      method: "POST",
      path: "/v1/responses",
      requestType: "responses",
      stream: false,
      model: "gpt-5-codex",
      statusCode: 200,
      latencyMs: 100,
      tenantId: "tenant-a",
    });
    logs.appendRequestLogDetail(id, {
      stageTimings: [
        {
          stage: "stage-only-search-token",
          label: "Stage only",
          durationMs: 1,
        },
      ],
    });

    const result = logs.queryRequestLogs({
      query: "stage-only-search-token",
      tenantId: "tenant-a",
    });

    expect(result.total).toBe(0);
  });
});
