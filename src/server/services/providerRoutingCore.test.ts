import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isProviderRoutingCredentialAvailable,
  routingModelMatchesAllowlist,
  selectProviderRoutingItem,
  wildcardModelMatch,
} from "@/src/server/services/providerRoutingCore";

describe("provider routing core", () => {
  afterEach(() => vi.restoreAllMocks());
  test("prefers healthy candidates before degraded higher-priority candidates", () => {
    const selected = selectProviderRoutingItem([{ id: "degraded", priority: 200, weight: 1, health: 40 }, { id: "healthy", priority: 100, weight: 1, health: 90 }], (item) => item.priority, (item) => item.weight, (item) => item.health);
    expect(selected.id).toBe("healthy");
  });
  test("uses priority within the same health tier", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const selected = selectProviderRoutingItem([{ id: "low", priority: 100, weight: 100, health: 100 }, { id: "high", priority: 200, weight: 1, health: 100 }], (item) => item.priority, (item) => item.weight, (item) => item.health);
    expect(selected.id).toBe("high");
  });
  test("matches provider model exclusion patterns", () => {
    expect(wildcardModelMatch("grok-*-preview", "grok-4-preview")).toBe(true);
    expect(wildcardModelMatch("grok-*-preview", "gpt-5.6-sol")).toBe(false);
  });
  test("shares thinking-suffix allowlist matching across providers", () => {
    expect(routingModelMatchesAllowlist("gpt-5.6-sol(high)", ["gpt-5.6-sol"])).toBe(true);
    expect(routingModelMatchesAllowlist("grok-4", ["grok-3"])).toBe(false);
  });
  test("shares tenant, exclusion and cooldown credential eligibility", () => {
    const credential = { id: "cred-1", enabled: true, cooldownUntil: null };
    expect(isProviderRoutingCredentialAvailable(credential, { now: 1, eligibleCredentialIds: new Set(["cred-1"]) })).toBe(true);
    expect(isProviderRoutingCredentialAvailable(credential, { now: 1, eligibleCredentialIds: new Set(["cred-1"]), excludedCredentialIds: new Set(["cred-1"]) })).toBe(false);
  });
});
