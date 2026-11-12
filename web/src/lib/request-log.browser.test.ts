import { describe, expect, it } from "vitest"
import type { RequestLog } from "./api"
import { requestTokenRate } from "./request-log"
describe("Magpie stream speed", () => {
  const log = {
    log_unit: "step",
    usage_quality: "complete",
    output: 100,
    total_tokens: 300,
    decode_out: 40,
    decode_ms: 1000,
  } as RequestLog
  it("uses the server's measured decode tokens and window", () => {
    expect(requestTokenRate(log)).toBe(40)
    expect(
      requestTokenRate({ ...log, output: 999999, total_tokens: 999999 })
    ).toBe(40)
  })
  it("does not reconstruct missing timing or show canceled speeds", () => {
    for (const patch of [
      { decode_ms: undefined },
      { decode_out: undefined },
      { decode_ms: 0 },
      { decode_out: -1 },
      { decode_ms: Number.NaN },
      { decode_out: Number.POSITIVE_INFINITY },
      { usage_quality: "missing" },
      { canceled: true },
      { log_unit: "connection" },
      { log_unit: "legacy_session" },
    ]) {
      expect(requestTokenRate({ ...log, ...patch })).toBeNull()
    }
  })
})
