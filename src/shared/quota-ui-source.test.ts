import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("quota workspace surfaces", () => {
  test("provides administrator and tenant quota analysis sections", () => {
    const adminPath = resolve(process.cwd(), "components/admin/quota-section.tsx");
    const tenantPath = resolve(process.cwd(), "components/tenant/quota-section.tsx");
    const allocationPath = resolve(process.cwd(), "components/admin/subscription-allocation-section.tsx");
    const quotaServicePath = resolve(process.cwd(), "src/server/services/tenantQuota.ts");
    expect(existsSync(adminPath)).toBe(true);
    expect(existsSync(tenantPath)).toBe(true);
    if (!existsSync(adminPath) || !existsSync(tenantPath)) return;
    expect(readFileSync(adminPath, "utf8")).not.toContain("每份 5 小时额度");
    expect(readFileSync(allocationPath, "utf8")).toContain("5 小时推测额度（USD）");
    expect(readFileSync(allocationPath, "utf8")).toContain("推测额度归属于每个主订阅容量池");
    expect(readFileSync(allocationPath, "utf8")).toContain("所有子订阅仅按所占份额继承");
    expect(readFileSync(tenantPath, "utf8")).toContain("模型成本剖析");
    expect(readFileSync(tenantPath, "utf8")).not.toMatch(/remaining|剩余/i);
    expect(readFileSync(allocationPath, "utf8")).not.toContain("remainingUnits");
    expect(readFileSync(quotaServicePath, "utf8")).not.toContain("remaining-nanousd");
  });
});
