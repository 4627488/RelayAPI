import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("provider credential UI", () => {
  test("shares the credential card shell across Codex and Grok", () => {
    const codex = readFileSync(resolve(process.cwd(), "components/admin/credentials-section.tsx"), "utf8");
    const grok = readFileSync(resolve(process.cwd(), "components/admin/grok-section.tsx"), "utf8");
    expect(codex).toContain("<ProviderCredentialCard");
    expect(grok).toContain("<ProviderCredentialCard");
    expect(codex).toContain("<ProviderQuotaWindows");
    expect(grok).toContain("<ProviderQuotaWindows");
    expect(codex).toContain("<ProviderCredentialRoutingFields");
    expect(grok).toContain("<ProviderCredentialRoutingFields");
  });

  test("uses provider-aware labels in shared routing and overview UI", () => {
    const channels = readFileSync(resolve(process.cwd(), "components/admin/channels-section.tsx"), "utf8");
    const overview = readFileSync(resolve(process.cwd(), "components/admin/overview-section.tsx"), "utf8");
    expect(channels).toContain("selectedProviderLabel");
    expect(channels).not.toContain("需要先连接 Codex 凭据");
    expect(channels).not.toContain("服务端默认 Codex 基础 URL");
    expect(channels).not.toContain('credentials.find((item) => item.provider === "codex")');
    expect(overview).toContain('label="上游凭据"');
    expect(overview).not.toContain('label="Codex 凭据"');
  });
});
