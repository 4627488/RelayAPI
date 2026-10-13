import { describe, expect, it } from "vitest"
import type { RequestLog } from "./api"
import { requestTokenRate } from "./request-log"

describe("request token rates", () => {
  const log = {
    log_unit: "step",
    total_tokens: 300,
    completion_tokens: 100,
    latency_ms: 2000,
    first_token_ms: 1000,
  } as RequestLog
  it("uses only output tokens after the first token", () => {
    expect(requestTokenRate(log)).toBe(100)
    expect(requestTokenRate({ ...log, total_tokens: 999999 })).toBe(100)
  })
  it("does not invent speeds for missing or invalid measurements", () => {
    for (const patch of [
      { latency_ms: 0 },
      { latency_ms: -1 },
      { completion_tokens: 0 },
      { completion_tokens: -1 },
      { first_token_ms: Number.NaN },
      { usage_quality: "missing" },
      { log_unit: "connection" },
      { log_unit: "legacy_session" },
    ]) {
      expect(requestTokenRate({ ...log, ...patch })).toBeNull()
    }
    expect(requestTokenRate({ ...log, first_token_ms: undefined })).toBeNull()
    expect(requestTokenRate({ ...log, first_token_ms: 2000 })).toBeNull()
    expect(requestTokenRate({ ...log, total_tokens: 0 })).toBe(100)
  })
})
