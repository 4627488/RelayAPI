import "server-only";

import { HttpError } from "@/src/server/http/errors";

const DEFAULT_IMAGES_MAIN_MODEL = "gpt-5.4-mini";
const DEFAULT_IMAGES_TOOL_MODEL = "gpt-image-2";
const MAX_IMAGE_EDIT_FILES = 10;
const MAX_IMAGE_EDIT_FILE_BYTES = 20 * 1024 * 1024;

type ImageAction = "generate" | "edit";
type ImageStreamPrefix = "image_generation" | "image_edit";

export type CodexImagesRequest = {
  payload: Record<string, unknown>;
  responseFormat: "b64_json" | "url";
  stream: boolean;
  model: string;
  requestBody: unknown;
  streamPrefix: ImageStreamPrefix;
};

type ImageCallResult = {
  result: string;
  revisedPrompt: string;
  outputFormat: string;
  size: string;
  background: string;
  quality: string;
};

type OutputItemRepairState = {
  byIndex: Map<number, Record<string, unknown>>;
  fallback: Record<string, unknown>[];
};

export function buildImagesGenerationsRequest(
  input: Record<string, unknown>,
): CodexImagesRequest {
  const imageModel = normalizeImagesModel(input.model);
  const prompt = stringValue(input.prompt);
  if (!prompt) {
    throw new HttpError(
      400,
      "missing_image_prompt",
      "Invalid request: prompt is required",
    );
  }

  const responseFormat = normalizeImagesResponseFormat(input.response_format);
  const tool = imageGenerationTool("generate", imageModel, input);
  const payload = buildImagesResponsesPayload(prompt, [], tool);

  return {
    payload,
    responseFormat,
    stream: Boolean(input.stream),
    model: stringValue(payload.model) || DEFAULT_IMAGES_MAIN_MODEL,
    requestBody: input,
    streamPrefix: "image_generation",
  };
}

export function buildImagesEditsJsonRequest(
  input: Record<string, unknown>,
): CodexImagesRequest {
  const imageModel = normalizeImagesModel(input.model);
  const prompt = stringValue(input.prompt);
  if (!prompt) {
    throw new HttpError(
      400,
      "missing_image_prompt",
      "Invalid request: prompt is required",
    );
  }

  const images = collectJsonImages(input);
  if (images.length === 0) {
    throw new HttpError(
      400,
      "missing_image_input",
      "Invalid request: images[].image_url is required (file_id is not supported)",
    );
  }

  const mask = imageUrlFromRecord(input.mask);
  const responseFormat = normalizeImagesResponseFormat(input.response_format);
  const tool = imageGenerationTool("edit", imageModel, input);
  if (mask) {
    tool.input_image_mask = { image_url: mask };
  } else if (isRecord(input.mask) && stringValue(input.mask.file_id)) {
    throw new HttpError(
      400,
      "unsupported_image_mask_file",
      "Invalid request: mask.file_id is not supported (use mask.image_url instead)",
    );
  }

  const payload = buildImagesResponsesPayload(prompt, images, tool);
  return {
    payload,
    responseFormat,
    stream: Boolean(input.stream),
    model: stringValue(payload.model) || DEFAULT_IMAGES_MAIN_MODEL,
    requestBody: input,
    streamPrefix: "image_edit",
  };
}

export async function buildImagesEditsMultipartRequest(
  formData: FormData,
): Promise<CodexImagesRequest> {
  const imageModel = normalizeImagesModel(formData.get("model"));
  const prompt = stringValue(formData.get("prompt"));
  if (!prompt) {
    throw new HttpError(
      400,
      "missing_image_prompt",
      "Invalid request: prompt is required",
    );
  }

  const bracketFiles = formData.getAll("image[]").filter(isFileLike);
  const files =
    bracketFiles.length > 0
      ? bracketFiles
      : formData.getAll("image").filter(isFileLike);
  if (files.length === 0) {
    throw new HttpError(
      400,
      "missing_image_input",
      "Invalid request: image is required",
    );
  }
  if (files.length > MAX_IMAGE_EDIT_FILES) {
    throw new HttpError(
      413,
      "too_many_image_inputs",
      `At most ${MAX_IMAGE_EDIT_FILES} image files are allowed`,
    );
  }

  const images = await Promise.all(files.map(fileToDataUrl));
  const responseFormat = normalizeImagesResponseFormat(
    formData.get("response_format"),
  );
  const tool = imageGenerationTool(
    "edit",
    imageModel,
    formRecordFromData(formData),
  );
  const mask = formData.get("mask");
  if (isFileLike(mask)) {
    tool.input_image_mask = { image_url: await fileToDataUrl(mask) };
  }

  const payload = buildImagesResponsesPayload(prompt, images, tool);
  return {
    payload,
    responseFormat,
    stream: booleanFormValue(formData.get("stream")),
    model: stringValue(payload.model) || DEFAULT_IMAGES_MAIN_MODEL,
    requestBody: {
      model: imageModel,
      prompt,
      image_count: images.length,
      has_mask: isFileLike(mask),
      response_format: responseFormat,
      stream: booleanFormValue(formData.get("stream")),
    },
    streamPrefix: "image_edit",
  };
}

export function buildImagesApiResponseFromSseText(
  text: string,
  responseFormat: "b64_json" | "url",
) {
  const outputItems = createOutputItemRepairState();
  for (const frame of parseSseFrames(text)) {
    const event = parseSseJson(frame);
    if (!event) {
      continue;
    }
    if (collectOutputItemDone(event, outputItems)) {
      continue;
    }
    if (event.type !== "response.completed") {
      continue;
    }
    const completed = extractImagesFromCompletedEvent(event, outputItems);
    return buildImagesApiResponse(completed, responseFormat);
  }
  throw new HttpError(
    502,
    "image_generation_incomplete",
    "Upstream stream ended before image generation completed",
  );
}

export function createImagesSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    responseFormat: "b64_json" | "url";
    streamPrefix: ImageStreamPrefix;
    onCompleted: () => void;
    onError: (error: unknown) => void;
    onFirstEvent?: () => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completed = false;
  let sawEvent = false;
  const outputItems = createOutputItemRepairState();

  function emit(
    controller: TransformStreamDefaultController<Uint8Array>,
    eventName: string,
    data: unknown,
  ) {
    controller.enqueue(
      encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  function emitError(
    controller: TransformStreamDefaultController<Uint8Array>,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    emit(controller, "error", {
      error: {
        message,
        type: "stream_error",
        code: "upstream_image_stream_error",
      },
    });
  }

  function fail(
    controller: TransformStreamDefaultController<Uint8Array>,
    error: unknown,
  ) {
    if (completed) {
      return;
    }
    completed = true;
    input.onError(error);
    emitError(controller, error);
  }

  function processFrame(
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    if (completed) {
      return;
    }
    const event = parseSseJson(frame);
    if (!event) {
      return;
    }
    if (!sawEvent) {
      sawEvent = true;
      input.onFirstEvent?.();
    }

    if (collectOutputItemDone(event, outputItems)) {
      return;
    }

    if (event.type === "response.image_generation_call.partial_image") {
      const image = partialImageEvent(event, input.responseFormat);
      if (image) {
        emit(controller, `${input.streamPrefix}.partial_image`, {
          type: `${input.streamPrefix}.partial_image`,
          ...image,
        });
      }
      return;
    }

    if (event.type === "response.completed") {
      const completedImages = extractImagesFromCompletedEvent(
        event,
        outputItems,
      );
      const payload = buildImagesStreamCompletedEvents(
        completedImages,
        input.responseFormat,
      );
      for (const item of payload) {
        emit(controller, `${input.streamPrefix}.completed`, {
          type: `${input.streamPrefix}.completed`,
          ...item,
        });
      }
      completed = true;
      input.onCompleted();
    }
  }

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = splitCompleteSseFrames(buffer);
        buffer = frames.remaining;
        try {
          for (const frame of frames.complete) {
            processFrame(frame, controller);
          }
        } catch (error) {
          fail(controller, error);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        try {
          for (const frame of parseSseFrames(buffer)) {
            processFrame(frame, controller);
          }
          if (!completed) {
            throw new Error(
              "Upstream stream ended before image generation completed",
            );
          }
        } catch (error) {
          fail(controller, error);
        }
      },
    }),
  );
}

function imageGenerationTool(
  action: ImageAction,
  model: string,
  input: Record<string, unknown>,
) {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    action,
    model,
  };
  const stringFields = [
    "size",
    "quality",
    "background",
    "output_format",
    "moderation",
    ...(action === "edit" ? ["input_fidelity"] : []),
  ];
  for (const field of stringFields) {
    const value = stringValue(input[field]);
    if (value) {
      tool[field] = value;
    }
  }
  for (const field of ["output_compression", "partial_images"]) {
    const value = numberValue(input[field]);
    if (value !== null) {
      tool[field] = value;
    }
  }
  return tool;
}

function buildImagesResponsesPayload(
  prompt: string,
  images: string[],
  tool: Record<string, unknown>,
) {
  const mainModel = imagesMainModelForTool(stringValue(tool.model));
  return {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: mainModel,
    store: false,
    tool_choice: { type: "image_generation" },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images
            .map((image) => image.trim())
            .filter(Boolean)
            .map((image_url) => ({ type: "input_image", image_url })),
        ],
      },
    ],
    tools: [tool],
  };
}

function extractImagesFromCompletedEvent(
  event: Record<string, unknown>,
  repairState: OutputItemRepairState = createOutputItemRepairState(),
) {
  const response = isRecord(event.response) ? event.response : event;
  const created =
    numberValue(response.created_at) ?? Math.floor(Date.now() / 1000);
  const output = repairedCompletedOutput(response, repairState);
  const results: ImageCallResult[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "image_generation_call") {
      continue;
    }
    const result = stringValue(item.result);
    if (!result) {
      continue;
    }
    results.push({
      result,
      revisedPrompt: stringValue(item.revised_prompt),
      outputFormat: stringValue(item.output_format),
      size: stringValue(item.size),
      background: stringValue(item.background),
      quality: stringValue(item.quality),
    });
  }
  if (results.length === 0) {
    throw new HttpError(
      502,
      "missing_image_output",
      "Upstream did not return image output",
    );
  }
  const toolUsage = isRecord(response.tool_usage)
    ? response.tool_usage.image_gen
    : undefined;
  return {
    created,
    results,
    usage: isRecord(toolUsage) ? toolUsage : null,
    firstMeta: results[0],
  };
}

function createOutputItemRepairState(): OutputItemRepairState {
  return { byIndex: new Map(), fallback: [] };
}

function collectOutputItemDone(
  event: Record<string, unknown>,
  state: OutputItemRepairState,
) {
  if (event.type !== "response.output_item.done" || !isRecord(event.item)) {
    return false;
  }
  const outputIndex = numberValue(event.output_index);
  if (outputIndex !== null) {
    state.byIndex.set(outputIndex, event.item);
  } else {
    state.fallback.push(event.item);
  }
  return true;
}

function repairedCompletedOutput(
  response: Record<string, unknown>,
  state: OutputItemRepairState,
) {
  const output = Array.isArray(response.output) ? response.output : [];
  if (output.length > 0 || (state.byIndex.size === 0 && state.fallback.length === 0)) {
    return output;
  }
  return [
    ...[...state.byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item),
    ...state.fallback,
  ];
}

function buildImagesApiResponse(
  input: ReturnType<typeof extractImagesFromCompletedEvent>,
  responseFormat: "b64_json" | "url",
) {
  const output: Record<string, unknown> = {
    created: input.created,
    data: input.results.map((image) =>
      imageApiDataItem(image, responseFormat),
    ),
  };
  if (input.firstMeta.background) {
    output.background = input.firstMeta.background;
  }
  if (input.firstMeta.outputFormat) {
    output.output_format = input.firstMeta.outputFormat;
  }
  if (input.firstMeta.quality) {
    output.quality = input.firstMeta.quality;
  }
  if (input.firstMeta.size) {
    output.size = input.firstMeta.size;
  }
  if (input.usage) {
    output.usage = input.usage;
  }
  return output;
}

function buildImagesStreamCompletedEvents(
  input: ReturnType<typeof extractImagesFromCompletedEvent>,
  responseFormat: "b64_json" | "url",
) {
  return input.results.map((image) => {
    const item = imageApiDataItem(image, responseFormat);
    if (input.usage) {
      item.usage = input.usage;
    }
    return item;
  });
}

function imageApiDataItem(
  image: ImageCallResult,
  responseFormat: "b64_json" | "url",
) {
  const item: Record<string, unknown> = {};
  if (responseFormat === "url") {
    item.url = `data:${mimeTypeFromOutputFormat(image.outputFormat)};base64,${
      image.result
    }`;
  } else {
    item.b64_json = image.result;
  }
  if (image.revisedPrompt) {
    item.revised_prompt = image.revisedPrompt;
  }
  return item;
}

function partialImageEvent(
  event: Record<string, unknown>,
  responseFormat: "b64_json" | "url",
) {
  const b64 = stringValue(event.partial_image_b64);
  if (!b64) {
    return null;
  }
  const item: Record<string, unknown> = {
    partial_image_index: numberValue(event.partial_image_index) ?? 0,
  };
  if (responseFormat === "url") {
    item.url = `data:${mimeTypeFromOutputFormat(
      stringValue(event.output_format),
    )};base64,${b64}`;
  } else {
    item.b64_json = b64;
  }
  return item;
}

function collectJsonImages(input: Record<string, unknown>) {
  const images = Array.isArray(input.images) ? input.images : [];
  return images.map(imageUrlFromRecord).filter(Boolean);
}

function imageUrlFromRecord(input: unknown) {
  if (typeof input === "string") {
    return input.trim();
  }
  if (!isRecord(input)) {
    return "";
  }
  if (typeof input.image_url === "string") {
    return input.image_url.trim();
  }
  if (isRecord(input.image_url)) {
    return stringValue(input.image_url.url);
  }
  return stringValue(input.url);
}

function imagesMainModelForTool(toolModel: string) {
  const index = toolModel.lastIndexOf("/");
  if (index > 0 && index < toolModel.length - 1) {
    const prefix = toolModel.slice(0, index).trim();
    if (prefix) {
      return `${prefix}/${DEFAULT_IMAGES_MAIN_MODEL}`;
    }
  }
  return DEFAULT_IMAGES_MAIN_MODEL;
}

function normalizeImagesModel(value: unknown) {
  const model = stringValue(value) || DEFAULT_IMAGES_TOOL_MODEL;
  const base = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (base === DEFAULT_IMAGES_TOOL_MODEL) {
    return model;
  }
  throw new HttpError(
    400,
    "unsupported_image_model",
    `Model ${model} is not supported on /v1/images/generations or /v1/images/edits. Use ${DEFAULT_IMAGES_TOOL_MODEL}.`,
  );
}

function normalizeImagesResponseFormat(value: unknown): "b64_json" | "url" {
  return stringValue(value).toLowerCase() === "url" ? "url" : "b64_json";
}

function parseSseFrames(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .map((frame) => frame.trim())
    .filter(Boolean);
}

function splitCompleteSseFrames(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n\n+/);
  const complete = parts.slice(0, -1).filter((frame) => frame.trim());
  const remaining = parts.at(-1) || "";
  return { complete, remaining };
}

function parseSseJson(frame: string) {
  const data = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    throw new HttpError(
      502,
      "invalid_image_sse_json",
      "Upstream returned invalid image SSE JSON",
    );
  }
}

function mimeTypeFromOutputFormat(outputFormat: string) {
  const value = outputFormat.trim().toLowerCase();
  if (value.includes("/")) {
    return value;
  }
  switch (value) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

async function fileToDataUrl(file: File) {
  if (file.size > MAX_IMAGE_EDIT_FILE_BYTES) {
    throw new HttpError(
      413,
      "image_file_too_large",
      "Image file is too large",
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const mediaType = file.type || "application/octet-stream";
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function formRecordFromData(formData: FormData) {
  const record: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

function isFileLike(value: unknown): value is File {
  return Boolean(
    value &&
      typeof value === "object" &&
      "arrayBuffer" in value &&
      typeof (value as File).arrayBuffer === "function",
  );
}

function booleanFormValue(value: FormDataEntryValue | null) {
  const raw = stringValue(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
