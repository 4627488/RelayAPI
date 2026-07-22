import { describe, expect, test } from "vitest";
import { channelDeclaresModel } from "@/src/server/services/channels";

describe("channel model declarations", () => {
  test("matches a model regardless of provider-style naming", () => {
    expect(channelDeclaresModel({ modelAllowlist: ["custom-reasoner"] }, "custom-reasoner")).toBe(true);
  });

  test("does not infer a provider from the model prefix", () => {
    expect(channelDeclaresModel({ modelAllowlist: ["gpt-5.5"] }, "grok-4.5")).toBe(false);
  });

  test("requires the channel to declare the model", () => {
    expect(channelDeclaresModel({ modelAllowlist: [] }, "gpt-5.5")).toBe(false);
  });

  test("matches a thinking suffix through the declared base model", () => {
    expect(channelDeclaresModel({ modelAllowlist: ["gpt-5.5"] }, "gpt-5.5(high)")).toBe(true);
  });
});
