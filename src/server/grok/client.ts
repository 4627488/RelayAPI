import "server-only";
import { proxiedFetch } from "@/src/server/net/proxy";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import type { ChannelRecord, TenantRuntimeContext } from "@/src/shared/types/entities";

const CLIENT_VERSION = "0.2.93";
export async function grokFetch(payload: Record<string, unknown>, input: { channel: ChannelRecord; tenant?: TenantRuntimeContext | null; stream: boolean }) {
  let credential = await ensureFreshGrokCredential(input.channel.credentialId);
  const oauth = credential.authType === "oauth"; const token = oauth ? credential.tokens.access_token : credential.tokens.api_key;
  const base = (input.channel.baseUrl || (oauth ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1")).replace(/\/+$/, "");
  const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: input.tenant ? true : credential.useGlobalProxy, tenantProxy: input.tenant?.proxy || null });
  let headers = buildHeaders(token, oauth, input.stream);
  const namespaceTools = collectNamespaceTools(payload.tools);
  const upstreamPayload = normalizeGrokPayload({ ...payload, stream: input.stream });
  const execute = () => proxiedFetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(upstreamPayload), signal: AbortSignal.timeout(input.stream ? 1_800_000 : 300_000) }, proxy);
  let response = await execute();
  if (response.status === 401 && oauth && credential.tokens.refresh_token) { await response.body?.cancel().catch(() => undefined); credential = await forceRefreshGrokCredential(credential.id); headers = buildHeaders(credential.tokens.access_token, true, input.stream); response = await execute(); }
  if (response.ok && namespaceTools.size > 0) response = restoreGrokNamespaceResponse(response, namespaceTools, input.stream);
  return { response, credential, upstreamPayload };
}

export function normalizeGrokPayload(payload: Record<string, unknown>) {
  const normalized = structuredClone(payload);
  if (Array.isArray(normalized.tools)) normalized.tools = flattenNamespaceTools(normalized.tools);
  normalized.tool_choice = normalizeNamespaceToolChoice(normalized.tool_choice);
  if (normalized.tool_choice && typeof normalized.tool_choice === "object" && !Array.isArray(normalized.tool_choice)) {
    const choice = normalized.tool_choice as Record<string, unknown>;
    if (Array.isArray(choice.tools)) choice.tools = choice.tools.map(normalizeNamespaceToolChoice).filter(Boolean);
  }
  if (!Array.isArray(normalized.tools) || normalized.tools.length === 0) {
    delete normalized.tools;
    delete normalized.tool_choice;
    delete normalized.parallel_tool_calls;
  }
  return normalized;
}

function flattenNamespaceTools(tools: unknown[]) {
  return tools.flatMap((rawTool) => {
    const tool = record(rawTool);
    if (!tool) return [];
    if (tool.type !== "namespace") return [normalizeGrokTool(tool, "")];
    const namespace = text(tool.name);
    return Array.isArray(tool.tools) ? tool.tools.flatMap((child) => {
      const childTool = record(child);
      return childTool ? [normalizeGrokTool(childTool, namespace)] : [];
    }) : [];
  }).filter(Boolean);
}

function normalizeGrokTool(tool: Record<string, unknown>, namespace: string) {
  const normalized = { ...tool };
  if (normalized.type === "custom") normalized.type = "function";
  if (normalized.type === "function") {
    normalized.name = qualifyToolName(namespace, text(normalized.name));
    normalized.parameters ??= { type: "object", properties: {} };
  }
  return normalized;
}

function normalizeNamespaceToolChoice(rawChoice: unknown): unknown {
  const choice = record(rawChoice);
  if (!choice || choice.type !== "function") return rawChoice;
  const namespace = text(choice.namespace);
  if (!namespace) return rawChoice;
  const normalized: Record<string, unknown> = { ...choice, name: qualifyToolName(namespace, text(choice.name)) };
  delete normalized.namespace;
  return normalized;
}

function qualifyToolName(namespace: string, name: string) {
  if (!namespace || !name || name.startsWith("mcp__")) return name;
  const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}
type NamespaceTool = { namespace: string; name: string };
function collectNamespaceTools(rawTools: unknown) {
  const refs = new Map<string, NamespaceTool>();
  if (!Array.isArray(rawTools)) return refs;
  for (const rawTool of rawTools) {
    const tool = record(rawTool);
    const namespace = tool?.type === "namespace" ? text(tool.name) : "";
    if (!namespace || !Array.isArray(tool?.tools)) continue;
    for (const rawChild of tool.tools) {
      const child = record(rawChild);
      const name = text(child?.name);
      if (name) refs.set(qualifyToolName(namespace, name), { namespace, name });
    }
  }
  return refs;
}

function restoreGrokNamespaceResponse(response: Response, refs: Map<string, NamespaceTool>, stream: boolean) {
  if (!response.body) return response;
  const body = stream ? response.body.pipeThrough(namespaceSseTransform(refs)) : response.body.pipeThrough(namespaceJsonTransform(refs));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function namespaceSseTransform(refs: Map<string, NamespaceTool>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const rewrite = (source: string) => source.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const json = line.slice(5).trimStart();
    if (!json || json === "[DONE]") return line;
    try { return `data: ${JSON.stringify(restoreNamespaceCalls(JSON.parse(json), refs))}`; } catch { return line; }
  }).join("\n");
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const boundary = pending.lastIndexOf("\n");
      if (boundary < 0) return;
      controller.enqueue(encoder.encode(rewrite(pending.slice(0, boundary + 1))));
      pending = pending.slice(boundary + 1);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    },
  });
}

function namespaceJsonTransform(refs: Map<string, NamespaceTool>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let body = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) { body += decoder.decode(chunk, { stream: true }); },
    flush(controller) {
      body += decoder.decode();
      try { controller.enqueue(encoder.encode(JSON.stringify(restoreNamespaceCalls(JSON.parse(body), refs)))); }
      catch { controller.enqueue(encoder.encode(body)); }
    },
  });
}

export function restoreNamespaceCalls(value: unknown, refs: Map<string, NamespaceTool>): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreNamespaceCalls(item, refs));
  const object = record(value);
  if (!object) return value;
  const restored = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, restoreNamespaceCalls(child, refs)]));
  const ref = (restored.type === "function_call" || restored.type === "custom_tool_call") ? refs.get(text(restored.name)) : undefined;
  if (ref) { restored.name = ref.name; restored.namespace = ref.namespace; }
  return restored;
}
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function buildHeaders(token: string, oauth: boolean, stream: boolean) { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json", ...(oauth ? { "X-XAI-Token-Auth": "xai-grok-cli", "X-Grok-Client-Version": CLIENT_VERSION } : {}) }; }
