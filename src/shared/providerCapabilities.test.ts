import { describe, expect, test } from "vitest";

import {
  providerCapacityUnits,
  providerDefaultBaseUrl,
  providerLabel,
  providerPlanLabel,
  normalizeProviderId,
} from "@/src/shared/providerCapabilities";

describe("provider capabilities", () => {
  test("describes Codex subscription capacity", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerPlanLabel("codex", "pro")).toBe("Pro 20x");
    expect(providerCapacityUnits("codex", "pro")).toBe(20);
  });

  test("describes Grok without leaking provider branches to consumers", () => {
    expect(providerLabel("grok")).toBe("Grok");
    expect(providerPlanLabel("grok", "supergrok-heavy")).toBe("SuperGrok Heavy");
    expect(providerCapacityUnits("grok", "supergrok-heavy")).toBe(1);
    expect(providerDefaultBaseUrl("grok", "https://codex.example/v1"))
      .toBe("https://cli-chat-proxy.grok.com/v1");
  });

  test("normalizes untrusted provider input", () => {
    expect(normalizeProviderId("grok")).toBe("grok");
    expect(normalizeProviderId("unknown")).toBe("codex");
  });
});
