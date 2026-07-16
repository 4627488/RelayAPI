import "server-only";
import { grokFetch } from "@/src/server/grok/client";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import { selectGrokChannel, recordGrokCredentialFailure, recordGrokCredentialSuccess } from "@/src/server/services/grokRouting";
import { chatCompletionsToCodex, codexResponseToChatCompletion, parseCodexSseResponse } from "@/src/server/codex/client";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import { HttpError, errorToResponse } from "@/src/server/http/errors";
import type { RelayApiKeyContext } from "@/src/shared/types/entities";

export function isGrokModel(value: unknown) { return typeof value === "string" && value.trim().toLowerCase().startsWith("grok"); }

export async function handleGrokResponses(request: Request) {
  try { const apiKey = authenticateRelayRequest(request); const payload = await jsonBody(request); const model = String(payload.model || "grok-4.5"); const stream = payload.stream !== false;
    const { response, credential } = await grokWithFailover(payload, { model, apiKey, stream });
    if (!response.ok) return await grokError(response, credential.id);
    recordGrokCredentialSuccess(credential.id); return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers, stream) });
  } catch (error) { return errorToResponse(error); }
}

export async function handleGrokChatCompletions(request: Request) {
  try { const apiKey = authenticateRelayRequest(request); const input = await jsonBody(request); const model = String(input.model || "grok-4.5"); const stream = input.stream === true; const converted = chatCompletionsToCodex(input, { stream, defaultModel: model });
    const { response, credential } = await grokWithFailover(converted.payload, { model, apiKey, stream: true });
    if (!response.ok) return await grokError(response, credential.id); recordGrokCredentialSuccess(credential.id);
    if (stream) return new Response(createOpenAIChatSseStream(response.body!, { fallbackModel: model, toolNameMaps: converted.toolNameMaps, includeUsage: Boolean((input.stream_options as Record<string, unknown> | undefined)?.include_usage) }), { headers: responseHeaders(response.headers, true) });
    const text = await response.text(); const raw = parseCodexSseResponse(text) || safeJson(text); return Response.json(codexResponseToChatCompletion(raw, model, converted.toolNameMaps));
  } catch (error) { return errorToResponse(error); }
}

async function grokWithFailover(payload: Record<string, unknown>, input: { model: string; apiKey: RelayApiKeyContext; stream: boolean }) {
  const excluded = new Set<string>(); let last: Awaited<ReturnType<typeof grokFetch>> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let selected: ReturnType<typeof selectGrokChannel>;
    try { selected = selectGrokChannel({ model: input.model, apiKey: input.apiKey, excludedCredentialIds: excluded }); } catch (error) { if (last) return last; throw error; }
    const result = await grokFetch(payload, { channel: selected.channel, tenant: input.apiKey.tenant, stream: input.stream }); last = result;
    if (result.response.ok || ![401, 403, 429, 500, 502, 503, 504].includes(result.response.status)) return result;
    const text = await result.response.text(); const retry = retryAfter(result.response.headers); recordGrokCredentialFailure(result.credential.id, result.response.status, text.slice(0, 500), retry); excluded.add(result.credential.id);
    last = { ...result, response: new Response(text, { status: result.response.status, headers: result.response.headers }) };
  }
  return last!;
}

async function grokError(response: Response, credentialId: string) { const text = await response.text(); const retry = retryAfter(response.headers); recordGrokCredentialFailure(credentialId, response.status, text.slice(0, 500), retry); return new Response(text, { status: response.status, headers: responseHeaders(response.headers, false) }); }
function retryAfter(headers: Headers) { const seconds = Number(headers.get("retry-after")); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000; for (const key of ["x-ratelimit-reset", "x-rate-limit-reset"]) { const value = Number(headers.get(key)); if (Number.isFinite(value) && value > 0) return Math.max(0, value * 1000 - Date.now()); } return null; }
function responseHeaders(source: Headers, stream: boolean) { const headers = new Headers(); headers.set("Content-Type", stream ? "text/event-stream; charset=utf-8" : source.get("content-type") || "application/json; charset=utf-8"); headers.set("Cache-Control", "no-cache, no-transform"); headers.set("X-Accel-Buffering", "no"); return headers; }
async function jsonBody(request: Request) { const value = await request.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_json", "Request body must be a JSON object"); return value as Record<string, unknown>; }
function safeJson(text: string) { try { return JSON.parse(text); } catch { return { object: "response", output: [] }; } }
