import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("quota workspace surfaces", () => {
  test("provides administrator and tenant quota analysis sections", () => {
    const adminPath = resolve(process.cwd(), "components/admin/quota-section.tsx");
    const tenantPath = resolve(process.cwd(), "components/tenant/quota-section.tsx");
    expect(existsSync(adminPath)).toBe(true);
    expect(existsSync(tenantPath)).toBe(true);
    if (!existsSync(adminPath) || !existsSync(tenantPath)) return;
    expect(readFileSync(adminPath, "utf8")).toContain("每份 5 小时额度");
    expect(readFileSync(tenantPath, "utf8")).toContain("模型成本剖析");
  });
});
