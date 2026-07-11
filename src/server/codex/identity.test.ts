import { describe, expect, test } from "vitest";
import { DEFAULT_CODEX_CLIENT_VERSION, pairCodexIdentity } from "@/src/server/codex/identity";

describe("Codex client identity", () => {
  test("pairs originator with the final official user agent", () => {
    expect(pairCodexIdentity({ userAgent: "codex-tui/0.144.1 (Mac OS; arm64)", originator: "codex_cli_rs" })).toMatchObject({
      originator: "codex-tui",
      userAgent: "codex-tui/0.144.1 (Mac OS; arm64)",
    });
  });

  test("restores an official trailer identity after an override", () => {
    expect(pairCodexIdentity({ userAgent: "custom/0.144.1 (Mac OS) terminal (codex-tui; 0.144.1)" })).toMatchObject({
      originator: "codex-tui",
      userAgent: "codex-tui/0.144.1 (Mac OS) terminal (codex-tui; 0.144.1)",
    });
  });

  test("falls back as a pair and raises an explicitly old version", () => {
    expect(pairCodexIdentity({ userAgent: "browser/1.0", version: "0.118.0" })).toMatchObject({
      originator: "codex_cli_rs",
      version: DEFAULT_CODEX_CLIENT_VERSION,
    });
  });
});
