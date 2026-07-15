import "server-only";

export function resolveCodexCompactionMode(input: {
  upstreamPath: "/responses" | "/responses/compact";
  payload: Record<string, unknown>;
  headers: Headers;
}) {
  const explicitCompact = input.upstreamPath === "/responses/compact";
  const triggered = hasCompactionTrigger(input.payload.input);
  const remoteV2 =
    input.payload.stream === true &&
    hasFeature(input.headers.get("x-codex-beta-features"), "remote_compaction_v2");
  const promoted = !explicitCompact && triggered && !remoteV2;
  return {
    upstreamPath: explicitCompact || promoted ? "/responses/compact" as const : "/responses" as const,
    compact: explicitCompact || promoted,
    promoted,
    clientWantsStream: promoted && input.payload.stream === true,
  };
}

export function codexCompactSseResponse(response: unknown) {
  const root = isRecord(response) ? structuredClone(response) : {};
  if (!stringValue(root.id)) root.id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!validUsage(root.usage)) delete root.usage;
  const frames: string[] = [];
  const output = Array.isArray(root.output) ? root.output : [];
  output.filter(isRecord).forEach((item, outputIndex) => {
    frames.push(sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    }));
  });
  frames.push(sse("response.completed", { type: "response.completed", response: root }));
  return frames.join("");
}

function hasCompactionTrigger(input: unknown) {
  return Array.isArray(input) && input.some((item) => isRecord(item) && item.type === "compaction_trigger");
}

function hasFeature(raw: string | null, feature: string) {
  return String(raw || "").split(",").some((value) => value.trim() === feature);
}

function validUsage(value: unknown) {
  return isRecord(value) && ["input_tokens", "output_tokens", "total_tokens"].every((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
