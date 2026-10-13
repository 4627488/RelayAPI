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
  it("distinguishes total throughput from generation speed", () => {
    expect(requestTokenRate(log)).toBe(150)
    expect(requestTokenRate(log, true)).toBe(100)
  })
  it("does not invent speeds for missing or invalid measurements", () => {
    for (const patch of [
      { latency_ms: 0 },
      { latency_ms: -1 },
      { total_tokens: 0 },
      { usage_quality: "missing" },
      { log_unit: "connection" },
      { log_unit: "legacy_session" },
    ]) {
      expect(requestTokenRate({ ...log, ...patch })).toBeNull()
    }
    expect(
      requestTokenRate({ ...log, first_token_ms: undefined }, true)
    ).toBeNull()
    expect(requestTokenRate({ ...log, first_token_ms: 2000 }, true)).toBeNull()
  })
})
