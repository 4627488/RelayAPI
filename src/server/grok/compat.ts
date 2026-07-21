export type GrokCompatibilityOptions = {
  nativeXSearch: boolean;
  clientToolCache: boolean;
  websocket?: boolean;
};

export type NamespaceTool = { namespace: string; name: string };

const REMOVED_FIELDS = ["prompt_cache_retention", "safety_identifier", "stream_options"];
const DROPPED_TOOL_TYPES = new Set(["tool_search", "image_generation"]);

export function prepareGrokPayload(payload: Record<string, unknown>, options: GrokCompatibilityOptions) {
  const normalized = structuredClone(payload);
  const namespaceTools = collectNamespaceTools(normalized.tools, normalized.input);
  for (const field of REMOVED_FIELDS) delete normalized[field];
  if (!options.websocket) delete normalized.previous_response_id;
  if (options.websocket) { delete normalized.stream; delete normalized.background; normalized.store = true; }
  if (!options.clientToolCache) delete normalized.prompt_cache_key;
  const promoted = collectAdditionalTools(normalized.input);
  normalized.input = normalizeInput(normalized.input);
  if (promoted.length > 0) normalized.tools = [...(Array.isArray(normalized.tools) ? normalized.tools : []), ...promoted];
  if (Array.isArray(normalized.tools)) normalized.tools = flattenTools(normalized.tools);
  normalizeToolChoice(normalized);
  normalizeImageRefs(normalized);
  if (options.nativeXSearch) ensureNativeXSearch(normalized);
  cleanupToolChoice(normalized);
  return { payload: normalized, namespaceTools };
}

function flattenTools(tools: unknown[]) {
  return tools.flatMap((rawTool) => {
    const tool = record(rawTool);
    if (!tool) return [];
    if (tool.type !== "namespace") {
      const normalized = normalizeTool(tool, "");
      return normalized ? [normalized] : [];
    }
    const namespace = text(tool.name);
    return Array.isArray(tool.tools) ? tool.tools.flatMap((child) => {
      const normalized = record(child) ? normalizeTool(record(child)!, namespace) : null;
      return normalized ? [normalized] : [];
    }) : [];
  });
}

function normalizeTool(tool: Record<string, unknown>, namespace: string) {
  const type = text(tool.type);
  const name = text(tool.name);
  if (DROPPED_TOOL_TYPES.has(type) || (type === "custom" && name === "apply_patch")) return null;
  const normalized = structuredClone(tool);
  if (normalized.type === "custom") normalized.type = "function";
  if (normalized.type === "web_search") delete normalized.external_web_access;
  if (normalized.type === "function") {
    normalized.name = qualifyToolName(namespace, name);
    normalized.parameters = normalizeParameters(normalized.parameters, text(normalized.name));
  }
  return normalized;
}

function normalizeParameters(value: unknown, toolName: string) {
  const parameters = record(value) ? structuredClone(record(value)!) : { type: "object", properties: {} };
  if (toolName === "codex_app__automation_update") return { type: "object", properties: {}, additionalProperties: true };
  if (parameters.type === "object") {
    for (const key of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(parameters[key])) continue;
      if (parameters[key].some((rawBranch) => { const branch = record(rawBranch); const type = branch?.type; return type !== undefined && type !== "object" && !(Array.isArray(type) && type.length > 0 && type.every((item) => item === "object")); })) return { type: "object", properties: {}, additionalProperties: true };
      parameters[key] = parameters[key].map((rawBranch) => {
        const branch = record(rawBranch);
        return branch && branch.type === undefined ? { ...branch, type: "object" } : rawBranch;
      });
    }
  }
  return parameters;
}

function normalizeToolChoice(payload: Record<string, unknown>) {
  payload.tool_choice = normalizeChoice(payload.tool_choice);
  const choice = record(payload.tool_choice);
  if (Array.isArray(choice?.tools)) choice.tools = choice.tools.map(normalizeChoice).filter(Boolean);
}

function normalizeChoice(rawChoice: unknown): unknown {
  const choice = record(rawChoice);
  if (!choice || choice.type !== "function") return rawChoice;
  const namespace = text(choice.namespace);
  if (!namespace) return rawChoice;
  const normalized: Record<string, unknown> = { ...choice, name: qualifyToolName(namespace, text(choice.name)) };
  delete normalized.namespace;
  return normalized;
}

function cleanupToolChoice(payload: Record<string, unknown>) {
  const tools = Array.isArray(payload.tools) ? payload.tools.filter(Boolean) : [];
  if (tools.length === 0) {
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
    return;
  }
  payload.tools = tools;
  const available = new Set(tools.map(toolKey).filter(Boolean));
  const choice = record(payload.tool_choice);
  if (!choice) return;
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    const allowedTools = choice.tools.filter((tool) => available.has(toolKey(tool)));
    choice.tools = allowedTools;
    if (allowedTools.length === 0) delete payload.tool_choice;
  } else if (!available.has(toolKey(choice))) delete payload.tool_choice;
}

function ensureNativeXSearch(payload: Record<string, unknown>) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (!tools.some((tool) => record(tool)?.type === "x_search")) tools.push({ type: "x_search" });
  payload.tools = tools;
  const choice = record(payload.tool_choice);
  if (choice?.type === "allowed_tools" && Array.isArray(choice.tools) && !choice.tools.some((tool) => record(tool)?.type === "x_search")) choice.tools.push({ type: "x_search" });
}

function normalizeInput(rawInput: unknown) {
  if (!Array.isArray(rawInput)) return rawInput;
  return rawInput.flatMap((rawItem) => {
    const item = record(rawItem);
    if (!item) return [rawItem];
    if (item.type === "custom_tool_call") {
      const callId = text(item.call_id); const name = text(item.name);
      if (!callId || !name) return [];
      return [{ type: "function_call", call_id: callId, name, arguments: jsonObjectString(item.input) }];
    }
    if (item.type === "custom_tool_call_output") {
      const callId = text(item.call_id); if (!callId) return [];
      return [{ type: "function_call_output", call_id: callId, output: outputString(item.output) }];
    }
    const normalized = structuredClone(item);
    if (normalized.type === "additional_tools") return [];
    if (normalized.type === "function_call" && text(normalized.namespace)) {
      normalized.name = qualifyToolName(text(normalized.namespace), text(normalized.name));
      delete normalized.namespace;
    }
    if (normalized.type === "reasoning") {
      if (normalized.content === null) delete normalized.content;
      if (normalized.encrypted_content === null) delete normalized.encrypted_content;
    }
    return [normalized];
  });
}

function collectAdditionalTools(rawInput: unknown) {
  if (!Array.isArray(rawInput)) return [];
  return rawInput.flatMap((item) => {
    const value = record(item);
    return value?.type === "additional_tools" && Array.isArray(value.tools) ? value.tools : [];
  });
}

function normalizeImageRefs(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(normalizeImageRefs); return; }
  const object = record(value); if (!object) return;
  for (const [key, child] of Object.entries(object)) {
    if (key === "image") normalizeImageRef(child);
    if ((key === "images" || key === "reference_images") && Array.isArray(child)) child.forEach(normalizeImageRef);
    normalizeImageRefs(child);
  }
}
function normalizeImageRef(value: unknown) {
  const ref = record(value); if (!ref) return;
  const nested = record(ref.image_url);
  const url = text(ref.url) || text(ref.image_url) || text(nested?.url);
  if (url) { ref.url = url; delete ref.image_url; }
}

export function collectNamespaceTools(rawTools: unknown, rawInput?: unknown) {
  const refs = new Map<string, NamespaceTool>();
  const collect = (tools: unknown) => {
    if (!Array.isArray(tools)) return;
    for (const rawTool of tools) {
      const tool = record(rawTool); const namespace = tool?.type === "namespace" ? text(tool.name) : "";
      if (!namespace || !Array.isArray(tool?.tools)) continue;
      for (const rawChild of tool.tools) { const name = text(record(rawChild)?.name); if (name) refs.set(qualifyToolName(namespace, name), { namespace, name }); }
    }
  };
  collect(rawTools);
  if (Array.isArray(rawInput)) for (const item of rawInput) { const value = record(item); if (value?.type === "additional_tools") collect(value.tools); }
  return refs;
}

export function restoreNamespaceCalls(value: unknown, refs: Map<string, NamespaceTool>): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreNamespaceCalls(item, refs));
  const object = record(value); if (!object) return value;
  const restored = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, restoreNamespaceCalls(child, refs)]));
  normalizeReasoningResponse(restored);
  const ref = (restored.type === "function_call" || restored.type === "custom_tool_call") ? refs.get(text(restored.name)) : undefined;
  if (ref) { restored.name = ref.name; restored.namespace = ref.namespace; }
  return restored;
}

function normalizeReasoningResponse(value: Record<string, unknown>) {
  if (value.type === "response.reasoning_text.delta") { value.type = "response.reasoning_summary_text.delta"; moveContentIndex(value); }
  else if (value.type === "response.reasoning_text.done") { value.type = "response.reasoning_summary_part.done"; value.part = { type: "summary_text", text: text(value.text) }; delete value.text; moveContentIndex(value); }
  else if ((value.type === "response.content_part.added" || value.type === "response.content_part.done") && record(value.part)?.type === "reasoning_text") { value.type = value.type === "response.content_part.added" ? "response.reasoning_summary_part.added" : "response.reasoning_summary_part.done"; record(value.part)!.type = "summary_text"; moveContentIndex(value); }
  if (value.type === "reasoning" && Array.isArray(value.content)) {
    const reasoning = value.content.filter((part) => record(part)?.type === "reasoning_text").map((part) => ({ ...record(part), type: "summary_text" }));
    if (reasoning.length) value.summary = [...(Array.isArray(value.summary) ? value.summary : []), ...reasoning];
    delete value.content;
  }
}
function moveContentIndex(value: Record<string, unknown>) { if (value.summary_index === undefined && value.content_index !== undefined) value.summary_index = value.content_index; delete value.content_index; }

function qualifyToolName(namespace: string, name: string) { if (!namespace || !name || name.startsWith("mcp__")) return name; const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`; return name.startsWith(prefix) ? name : `${prefix}${name}`; }
function toolKey(value: unknown) { const tool = record(value); if (!tool) return ""; const type = text(tool.type); return type === "function" ? `${type}:${text(tool.name)}` : type; }
function jsonObjectString(value: unknown) { if (typeof value === "string") { try { const parsed = JSON.parse(value); if (record(parsed)) return JSON.stringify(parsed); } catch {} return JSON.stringify({ input: value }); } return record(value) ? JSON.stringify(value) : JSON.stringify({ input: value }); }
function outputString(value: unknown) { return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value); }
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
