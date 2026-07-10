import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "components/workspace/workspace-shell.tsx"),
  "utf8",
);

describe("WorkspaceShell contract", () => {
  it("groups navigation without legacy presentation props", () => {
    expect(source).toContain("group?: string");
    expect(source).not.toContain("eyebrow:");
    expect(source).not.toContain("snapshot:");
    expect(source).toContain('aria-label="主导航"');
  });
});
