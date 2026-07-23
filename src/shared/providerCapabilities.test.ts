import { describe, expect, test } from "vitest";

import {
  providerCapacityUnits,
  providerDefaultBaseUrl,
  providerCredentialDefaultBaseUrl,
  providerCredentialIdentity,
  providerCredentialName,
  providerLabel,
  providerPlanLabel,
  providerUnavailableChannelCode,
  providerSupportsAutomaticQuota,
  normalizeProviderId,
} from "@/src/shared/providerCapabilities";

describe("provider capabilities", () => {
  test("describes Codex subscription capacity", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerPlanLabel("codex", "pro")).toBe("Pro 20x");
    expect(providerCapacityUnits("codex", "pro")).toBe(20);
    expect(providerUnavailableChannelCode("codex")).toBe(
      "no_available_channel",
    );
    expect(providerSupportsAutomaticQuota("codex")).toBe(true);
  });

  test("describes Grok without leaking provider branches to consumers", () => {
    expect(providerLabel("grok")).toBe("Grok");
    expect(providerPlanLabel("grok", "supergrok-heavy")).toBe(
      "SuperGrok Heavy",
    );
    expect(providerCapacityUnits("grok", "supergrok-heavy")).toBe(1);
    expect(providerDefaultBaseUrl("grok", "https://codex.example/v1")).toBe(
      "https://cli-chat-proxy.grok.com/v1",
    );
    expect(providerUnavailableChannelCode("grok")).toBe(
      "no_available_grok_channel",
    );
    expect(providerSupportsAutomaticQuota("grok", "oauth")).toBe(true);
    expect(providerSupportsAutomaticQuota("grok", "api_key")).toBe(false);
    expect(
      providerCredentialDefaultBaseUrl(
        { provider: "grok", authType: "api_key" } as never,
        "https://codex.example/v1",
      ),
    ).toBe("https://api.x.ai/v1");
    expect(
      providerCredentialDefaultBaseUrl(
        { provider: "grok", authType: "oauth" } as never,
        "https://codex.example/v1",
      ),
    ).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(
      providerCredentialDefaultBaseUrl(
        {
          provider: "grok",
          authType: "oauth",
          grokBaseUrl: "https://grok.example/v1",
        } as never,
        "https://codex.example/v1",
      ),
    ).toBe("https://grok.example/v1");
  });

  test("normalizes untrusted provider input", () => {
    expect(normalizeProviderId("grok")).toBe("grok");
    expect(normalizeProviderId("unknown")).toBe("codex");
  });

  test("normalizes provider credential identity and display names", () => {
    const codex = {
      provider: "codex",
      id: "c1",
      email: "",
      accountId: "acct-1",
    } as Parameters<typeof providerCredentialName>[0];
    const grok = {
      provider: "grok",
      id: "g1",
      email: "grok@example.com",
      subject: "subject-1",
    } as Parameters<typeof providerCredentialName>[0];
    expect(providerCredentialIdentity(codex)).toBe("acct-1");
    expect(providerCredentialIdentity(grok)).toBe("subject-1");
    expect(providerCredentialName(codex)).toBe("acct-1");
    expect(providerCredentialName(grok)).toBe("grok@example.com");
  });
});
