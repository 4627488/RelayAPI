import { describe, expect, test } from "vitest";
import {
  applyCodexModelHeaderOverrides,
  parseCodexModelHeaderOverrides,
} from "@/src/server/codex/headerProfiles";

describe("Codex model header profiles", () => {
  test("merges wildcard and exact model profiles with exact precedence", () => {
    const profiles = parseCodexModelHeaderOverrides(
      JSON.stringify({
        "*": {
          "user-agent": "wildcard-agent",
          "x-codex-beta-features": "wildcard-beta",
        },
        "gpt-5.3-codex": {
          "User-Agent": "model-agent",
          Originator: "codex_cli_rs",
        },
      }),
    );

    expect(
      applyCodexModelHeaderOverrides(
        { "User-Agent": "base-agent", Accept: "application/json" },
        profiles,
        "gpt-5.3-codex",
      ),
    ).toEqual({
      "User-Agent": "model-agent",
      Accept: "application/json",
      "X-Codex-Beta-Features": "wildcard-beta",
      Originator: "codex_cli_rs",
    });
  });

  test("does not leak one model profile into another", () => {
    const profiles = parseCodexModelHeaderOverrides(
      '{"gpt-5.3-codex":{"Originator":"model-only"}}',
    );

    expect(
      applyCodexModelHeaderOverrides({}, profiles, "gpt-5.2-codex"),
    ).toEqual({});
  });

  test.each([
    ['{"*":{"Authorization":"secret"}}', "unsupported header"],
    ['{"*":{"User-Agent":12}}', "string values"],
    ['{"*":{"User-Agent":"bad\\nvalue"}}', "control characters"],
    ["[]", "JSON object"],
    ['{"*":null}', "header object"],
  ])("rejects invalid configuration %#", (raw, expected) => {
    expect(() => parseCodexModelHeaderOverrides(raw)).toThrow(expected);
  });

  test("rejects malformed JSON with the environment variable name", () => {
    expect(() => parseCodexModelHeaderOverrides("{"))
      .toThrow("CODEX_MODEL_HEADER_OVERRIDES must be valid JSON");
  });

  test("treats an unset variable as an empty profile map", () => {
    expect(parseCodexModelHeaderOverrides(undefined)).toEqual({});
  });
});
