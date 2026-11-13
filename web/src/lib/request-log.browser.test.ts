import { describe, expect, it } from "vitest"
import type { RequestLog } from "./api"
import { requestLogCostRows, requestTokenRate } from "./request-log"
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

describe("Magpie billing breakdown", () => {
  it("keeps cache separate and includes reasoning in output exactly once", () => {
    const rows = requestLogCostRows({
      pricing_complete: true,
      price_model: "codex-model",
      input: 100,
      cache_read: 900,
      cache_write: 80,
      cache_write_1h: 30,
      output: 50,
      reasoning: 40,
      input_price_nano_usd_per_token: 2,
      cached_input_price_nano_usd_per_token: 1,
      output_price_nano_usd_per_token: 10,
      reasoning_price_nano_usd_per_token: 999,
      cache_write_price_nano_usd_per_token: 3,
      cache_write_1h_nano_usd_per_token: 4,
    } as RequestLog)
    expect(rows).toEqual([
      ["文本输入（未缓存）", 100, 2],
      ["文本缓存读取", 900, 1],
      ["缓存写入", 50, 3],
      ["缓存写入（1 小时）", 30, 4],
      ["文本输出（含推理）", 50, 10],
    ])
    expect(
      rows.reduce((total, [, tokens, rate]) => total + tokens * rate, 0)
    ).toBe(1870)
  })
  it("separates cached images from uncached image input", () => {
    expect(
      requestLogCostRows({
        pricing_complete: true,
        price_model: "model",
        input: 95,
        cache_read: 15,
        image_input_tokens: 100,
        cached_image_input_tokens: 10,
        output: 20,
        image_output_tokens: 5,
        cache_write: 0,
        input_price_nano_usd_per_token: 1,
        cached_input_price_nano_usd_per_token: 2,
        image_input_price_nano_usd_per_token: 3,
        cached_image_input_price_nano_usd_per_token: 4,
        output_price_nano_usd_per_token: 5,
        image_output_price_nano_usd_per_token: 6,
      } as RequestLog)
    ).toEqual([
      ["文本输入（未缓存）", 5, 1],
      ["文本缓存读取", 5, 2],
      ["图片输入（未缓存）", 90, 3],
      ["图片缓存读取", 10, 4],
      ["文本输出（含推理）", 15, 5],
      ["图片输出", 5, 6],
    ])
  })
})
