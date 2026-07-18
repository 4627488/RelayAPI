import "server-only";

import { HttpError } from "@/src/server/http/errors";
import type { StageTimer } from "@/src/server/http/stageTimer";
import type { UsageSnapshot } from "@/src/shared/types/entities";

const DETAIL_TEXT_LIMIT = 512 * 1024;
const JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

export function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export function createTextCapture() {
  return {
    text: "",
    truncated: false,
    append(chunk: string) {
      if (this.truncated) {
        return;
      }
      if (this.text.length + chunk.length > DETAIL_TEXT_LIMIT) {
        this.text = `${this.text}${chunk}`.slice(0, DETAIL_TEXT_LIMIT);
        this.text += "\n...[truncated]";
        this.truncated = true;
        return;
      }
      this.text += chunk;
    },
  };
}

export function tapStream(
  body: ReadableStream<Uint8Array>,
  capture: ReturnType<typeof createTextCapture> | null,
  timing?: StageTimer,
) {
  const decoder = new TextDecoder();
  const transfer = timing?.start("stream_transfer", "流式传输");
  let sawFirstChunk = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          timing?.mark("stream_first_chunk", "收到上游首包");
        }
        capture?.append(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        const tail = decoder.decode();
        if (tail) {
          capture?.append(tail);
        }
        transfer?.finish();
      },
    }),
  );
}

export async function readJsonObject(request: Request) {
  assertContentLength(request, JSON_BODY_LIMIT_BYTES);
  const text = await readRequestTextWithLimit(request, JSON_BODY_LIMIT_BYTES);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(
        400,
        "invalid_json_object",
        "Request body must be a JSON object",
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export function assertContentLength(
  request: Request,
  limitBytes: number,
  options: { requireKnownLength?: boolean } = {},
) {
  const raw = request.headers.get("content-length");
  if (!raw) {
    if (options.requireKnownLength) {
      throw new HttpError(
        411,
        "content_length_required",
        "Content-Length is required for this request",
      );
    }
    return;
  }
  const contentLength = Number(raw);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new HttpError(400, "invalid_content_length", "Invalid Content-Length");
  }
  if (contentLength > limitBytes) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }
}

export async function readRequestTextWithLimit(request: Request, limitBytes: number) {
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > limitBytes) {
        throw new HttpError(413, "body_too_large", "Request body is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  reader.releaseLock();
  return new TextDecoder().decode(concatUint8Arrays(chunks, total));
}

export function concatUint8Arrays(chunks: Uint8Array[], total: number) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function upstreamErrorResponse(status: number) {
  const safeStatus = status >= 400 && status <= 599 ? status : 502;
  return Response.json(
    {
      error: {
        code: "upstream_error",
        message: "Upstream request failed",
      },
    },
    { status: safeStatus },
  );
}

export function withDefaultContentType(headers: Headers, contentType: string) {
  if (!headers.get("content-type")) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

export function withStreamingHeaders(headers: Headers) {
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  return headers;
}

export function isFreeCodexPlan(planType: string) {
  return planType.trim().toLowerCase() === "free";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

export function emptyUsage(): UsageSnapshot {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export function mergeHeaders(...inputs: HeadersInit[]) {
  const output = new Headers();
  for (const input of inputs) {
    new Headers(input).forEach((value, key) => output.set(key, value));
  }
  return output;
}
