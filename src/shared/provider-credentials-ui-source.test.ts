import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("provider credential workspace", () => {
  test("uses one connection entry and one credential card grid", () => {
    const credentials = readFileSync(resolve(process.cwd(), "components/admin/credentials-section.tsx"), "utf8");
    const grokCards = readFileSync(resolve(process.cwd(), "components/admin/grok-section.tsx"), "utf8");
    const sharedCard = readFileSync(resolve(process.cwd(), "components/admin/provider-credential-card.tsx"), "utf8");
    const workbench = readFileSync(resolve(process.cwd(), "components/admin-workbench.tsx"), "utf8");

    expect(credentials).toContain("连接上游凭据");
    expect(credentials).toContain("{providerControls}");
    expect(credentials).toContain("<ProviderCredentialCard");
    expect(grokCards).toContain("<ProviderCredentialCard");
    expect(sharedCard).toContain("className=\"relative shadow-sm\"");
    expect(sharedCard).toContain("剩余额度：");
    expect(grokCards).toContain("GrokSettingsDialog");
    expect(grokCards).not.toContain("连接 Grok 订阅");
    expect(grokCards).not.toContain("Grok 凭据</div>");
    expect(grokCards).not.toContain('listProviderCredentials("grok")');
    expect(grokCards).toContain("credentials.map((item)");
    expect(workbench).not.toContain("<GrokSection");
  });
});
