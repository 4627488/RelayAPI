import { expect, it } from "vitest"
import { cacheHitRate } from "./format"
it("excludes unknown observations from both cache-rate quantities", () => {
  expect(cacheHitRate(900, 100, 0, 900, 800)).toBe(1)
  expect(cacheHitRate(900, 100, 0, 1000, 900)).toBeNull()
  expect(cacheHitRate(80, 20, 0, true)).toBeNull()
})
