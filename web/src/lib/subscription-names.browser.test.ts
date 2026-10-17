import { expect, it } from "vitest"
import { defaultSubscriptionName } from "./subscription-names"

it.each([
  ["codex", "pro", 1000000, "ChatGPT Pro 20X"],
  ["codex", "pro", 125000, "ChatGPT Pro 2.5X"],
  ["codex", "pro", 100000, "ChatGPT Pro 2X"],
  ["claude", "", 1000000, "Claude 5X"],
  ["claude", "", 250000, "Claude 1.25X"],
  ["claude", "", 1, "Claude 0.000005X"],
  ["xai", "SuperGrok Heavy", 250000, "Grok SuperHeavy 1/4"],
  ["xai", "SuperGrok Heavy", 500000, "Grok SuperHeavy 1/2"],
  ["xai", "SuperGrok Heavy", 333333, "Grok SuperHeavy 333333/1000000"],
  ["unknown", "private@example.com", 250000, "共享订阅 1/4"],
] as const)("names %s %s at %s ppm as %s", (provider, plan, ppm, expected) => {
  expect(
    defaultSubscriptionName(
      { provider, plan_type: plan, capacity_mode: "observed" },
      ppm
    )
  ).toBe(expected)
})
