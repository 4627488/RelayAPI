# Codex Compatibility Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Codex request fidelity with conditional tool parallelism, model-specific header profiles, and resilient reusable WebSocket sessions.

**Architecture:** Keep payload policy in the existing Codex client, add one pure server-only module for parsing and applying header profiles, and extend the existing WebSocket session manager without changing its public response type. Reuse the current Codex error classifier by attaching classified metadata to WebSocket close errors.

**Tech Stack:** Next.js 16.2.6 server-only modules, TypeScript, Web Streams, `ws` 8.18, Vitest 4.1.

## Global Constraints

- Do not change channel selection, credential fairness, or public API contracts.
- `CODEX_MODEL_HEADER_OVERRIDES` is environment-only; do not add database schema or UI.
- Header overrides are restricted to `User-Agent`, `Originator`, `x-codex-beta-features`, and `OpenAI-Beta`.
- Reconnect and resend at most once, and only before the first upstream response event.
- Do not log configured header values.
- Session-affinity routing, identity remapping, and a downstream `/v1/ws` endpoint remain out of scope.
- Follow the server-only boundary documented in `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`.

---

## File Structure

- Modify `src/server/codex/client.ts`: apply conditional `parallel_tool_calls`, resolve model profiles, and pass the effective model into header construction.
- Modify `src/server/codex/client.test.ts`: cover all payload conversion paths and profile integration.
- Create `src/server/codex/headerProfiles.ts`: validate, canonicalize, merge, and apply model-specific header overrides.
- Create `src/server/codex/headerProfiles.test.ts`: test parsing, allowlisting, precedence, isolation, and control-character rejection.
- Modify `src/server/config/env.ts`: parse `CODEX_MODEL_HEADER_OVERRIDES` once at startup and expose it through `serverConfig`.
- Modify `src/server/codex/websocket.ts`: add idle ping/pong liveness, one pre-event reconnect, and classified close errors.
- Modify `src/server/codex/websocket.test.ts`: exercise liveness, retry boundaries, cancellation, and close metadata with fake sockets and timers.
- Modify `README.md`: document the environment variable, allowlist, wildcard, and exact-model precedence.

## Task 1: Conditional Tool Parallelism

**Files:**
- Modify: `src/server/codex/client.ts`
- Test: `src/server/codex/client.test.ts`

**Interfaces:**
- Produces: `normalizeParallelToolCalls(payload: Record<string, unknown>): void` as a private shared policy helper.
- Consumed by: `normalizeResponsesPayload`, `normalizeRawCodexResponsesPayload`, and `chatCompletionsToCodex`.

- [ ] **Step 1: Write failing payload tests**

Add imports for `normalizeResponsesPayload`, `normalizeRawCodexResponsesPayload`, and `chatCompletionsToCodex`, then add these cases:

```ts
describe("parallel_tool_calls normalization", () => {
  test.each([
    ["missing", undefined],
    ["empty", []],
  ])("removes parallel_tool_calls when tools are %s", (_label, tools) => {
    const input = {
      model: "gpt-5.3-codex",
      input: [],
      parallel_tool_calls: true,
      ...(tools === undefined ? {} : { tools }),
    };

    expect(normalizeResponsesPayload(input)).not.toHaveProperty(
      "parallel_tool_calls",
    );
    expect(normalizeRawCodexResponsesPayload(input)).not.toHaveProperty(
      "parallel_tool_calls",
    );
  });

  test("defaults to true with tools and preserves an explicit false", () => {
    const tool = { type: "function", name: "lookup", parameters: {} };
    expect(normalizeResponsesPayload({ input: [], tools: [tool] })).toHaveProperty(
      "parallel_tool_calls",
      true,
    );
    expect(
      normalizeResponsesPayload({
        input: [],
        tools: [tool],
        parallel_tool_calls: false,
      }),
    ).toHaveProperty("parallel_tool_calls", false);
  });

  test("applies the same rule after Chat Completions tool conversion", () => {
    expect(chatCompletionsToCodex({ messages: [] })).not.toHaveProperty(
      "parallel_tool_calls",
    );
    expect(
      chatCompletionsToCodex({
        messages: [],
        parallel_tool_calls: false,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
    ).toHaveProperty("parallel_tool_calls", false);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run: `pnpm test src/server/codex/client.test.ts`

Expected: failures show `parallel_tool_calls` remains `true` when tools are absent and explicit `false` is overwritten.

- [ ] **Step 3: Implement the shared normalization policy**

Add the helper near the payload normalizers:

```ts
function normalizeParallelToolCalls(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    delete payload.parallel_tool_calls;
    return;
  }
  if (typeof payload.parallel_tool_calls !== "boolean") {
    payload.parallel_tool_calls = true;
  }
}
```

Remove unconditional `parallel_tool_calls = true` assignments. Call the helper after tools have reached their final form in each of the three conversion paths. For Chat Completions, copy a boolean caller value before calling the helper:

```ts
if (typeof payload.parallel_tool_calls === "boolean") {
  out.parallel_tool_calls = payload.parallel_tool_calls;
}
normalizeParallelToolCalls(out);
```

- [ ] **Step 4: Run the focused tests and verify the green state**

Run: `pnpm test src/server/codex/client.test.ts`

Expected: all client tests pass.

- [ ] **Step 5: Commit the payload change**

```bash
git add src/server/codex/client.ts src/server/codex/client.test.ts
git commit -m "fix: normalize codex tool parallelism"
```

## Task 2: Model-Specific Header Profiles

**Files:**
- Create: `src/server/codex/headerProfiles.ts`
- Create: `src/server/codex/headerProfiles.test.ts`
- Modify: `src/server/config/env.ts`
- Modify: `src/server/codex/client.ts`
- Modify: `src/server/codex/client.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `CodexModelHeaderOverrides`, `parseCodexModelHeaderOverrides(raw: string | undefined): CodexModelHeaderOverrides`, and `applyCodexModelHeaderOverrides(headers, overrides, model): Record<string, string>`.
- Consumed by: `serverConfig.codexModelHeaderOverrides` and `buildCodexHeaders`.

- [ ] **Step 1: Write failing parser and precedence tests**

Create `src/server/codex/headerProfiles.test.ts`:

```ts
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
    ['[]', "JSON object"],
    ['{"*":null}', "header object"],
  ])("rejects invalid configuration %#", (raw, expected) => {
    expect(() => parseCodexModelHeaderOverrides(raw)).toThrow(expected);
  });

  test("treats an unset variable as an empty profile map", () => {
    expect(parseCodexModelHeaderOverrides(undefined)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the header test and verify it fails because the module is missing**

Run: `pnpm test src/server/codex/headerProfiles.test.ts`

Expected: FAIL resolving `@/src/server/codex/headerProfiles`.

- [ ] **Step 3: Implement strict parsing and case-insensitive allowlisting**

Create `src/server/codex/headerProfiles.ts` with server-only protection and these public functions:

```ts
import "server-only";

export type CodexModelHeaderOverrides = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const ALLOWED_HEADERS = new Map([
  ["user-agent", "User-Agent"],
  ["originator", "Originator"],
  ["x-codex-beta-features", "X-Codex-Beta-Features"],
  ["openai-beta", "OpenAI-Beta"],
]);

export function parseCodexModelHeaderOverrides(
  raw: string | undefined,
): CodexModelHeaderOverrides {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("CODEX_MODEL_HEADER_OVERRIDES must be valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("CODEX_MODEL_HEADER_OVERRIDES must be a JSON object");
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [model, rawHeaders] of Object.entries(parsed)) {
    if (!model.trim() || !isRecord(rawHeaders)) {
      throw new Error(`CODEX_MODEL_HEADER_OVERRIDES.${model} must be a header object`);
    }
    const headers: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(rawHeaders)) {
      const name = ALLOWED_HEADERS.get(rawName.toLowerCase());
      if (!name) {
        throw new Error(`CODEX_MODEL_HEADER_OVERRIDES contains unsupported header: ${rawName}`);
      }
      if (typeof value !== "string") {
        throw new Error("CODEX_MODEL_HEADER_OVERRIDES header values must be strings");
      }
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("CODEX_MODEL_HEADER_OVERRIDES header values must not contain control characters");
      }
      headers[name] = value;
    }
    result[model] = headers;
  }
  return result;
}

export function applyCodexModelHeaderOverrides(
  headers: Record<string, string>,
  overrides: CodexModelHeaderOverrides,
  model: string,
) {
  return {
    ...headers,
    ...(overrides["*"] || {}),
    ...(overrides[model] || {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run parser tests and verify they pass**

Run: `pnpm test src/server/codex/headerProfiles.test.ts`

Expected: all header profile unit tests pass.

- [ ] **Step 5: Wire startup parsing and upstream header application**

In `src/server/config/env.ts`, import the parser and add:

```ts
const codexModelHeaderOverrides = parseCodexModelHeaderOverrides(
  process.env.CODEX_MODEL_HEADER_OVERRIDES,
);

// inside serverConfig
codexModelHeaderOverrides,
```

In `src/server/codex/client.ts`, pass `stringValue(upstreamPayload.model)` into `buildCodexHeaders`. Change `const headers` in that function to `let headers`, apply profiles after client/global headers and before `Session_id` generation:

```ts
headers = applyCodexModelHeaderOverrides(
  headers,
  serverConfig.codexModelHeaderOverrides,
  input.model,
);
```

Add `model: string` to the private `buildCodexHeaders` input type. This ordering guarantees a profile-supplied Mac-style `User-Agent` participates in existing `Session_id` generation.

- [ ] **Step 6: Add an integration assertion for session generation order**

Export `buildCodexHeaders` for focused testing and add a test that supplies a profile-generated Mac User-Agent, stubs `crypto.randomUUID`, and verifies `Session_id` exists. Use a minimal credential object with `tokens.access_token`, `userAgent`, and `accountId`; keep the function's production behavior unchanged.

```ts
expect(headers).toMatchObject({
  "User-Agent": "codex_cli_rs/test (Mac OS 26.3; arm64)",
  Session_id: "00000000-0000-4000-8000-000000000000",
});
```

- [ ] **Step 7: Document the environment variable**

Add a `Codex Model Header Overrides` section after `Codex User-Agent` in `README.md` with this exact example and precedence:

```env
CODEX_MODEL_HEADER_OVERRIDES='{"*":{"x-codex-beta-features":"responses_websockets=2026-07-10"},"gpt-5.3-codex":{"User-Agent":"codex_cli_rs/...","Originator":"codex_cli_rs"}}'
```

Document: existing resolved headers < `*` profile < exact model profile; only the four allowlisted headers are accepted; invalid configuration prevents startup.

- [ ] **Step 8: Run focused tests and commit the header feature**

Run: `pnpm test src/server/codex/headerProfiles.test.ts src/server/codex/client.test.ts`

Expected: all focused tests pass.

```bash
git add src/server/codex/headerProfiles.ts src/server/codex/headerProfiles.test.ts src/server/config/env.ts src/server/codex/client.ts src/server/codex/client.test.ts README.md
git commit -m "feat: add codex model header profiles"
```

## Task 3: WebSocket Idle Liveness And One-Shot Resend

**Files:**
- Modify: `src/server/codex/websocket.ts`
- Test: `src/server/codex/websocket.test.ts`

**Interfaces:**
- Extends private `CodexWebSocketLike` with optional `ping(callback?)` and `pong` event support.
- Extends `CodexWebSocketSessionManager` constructor with `keepAliveIntervalMs?: number`.
- Preserves `request(...): Promise<Response>` and all external call sites.

- [ ] **Step 1: Extend the fake socket and write failing keepalive tests**

Add `pings`, `sendErrors`, and `ping()` behavior to `FakeSocket`, then use fake timers:

```ts
it("keeps an idle session alive when pong follows ping", async () => {
  vi.useFakeTimers();
  const { manager, sockets } = createManager({ keepAliveIntervalMs: 1_000 });
  await completeRequest(manager, sockets, "one");

  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets[0].pings).toBe(1);
  sockets[0].emit("pong");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets[0].terminated).toBe(false);
  manager.closeAll();
  vi.useRealTimers();
});

it("terminates an idle session that misses its pong", async () => {
  vi.useFakeTimers();
  const { manager, sockets } = createManager({ keepAliveIntervalMs: 1_000 });
  await completeRequest(manager, sockets, "one");

  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets[0].terminated).toBe(true);
  manager.closeAll();
  vi.useRealTimers();
});
```

Keep timer restoration in `afterEach` so failures do not contaminate later tests.

- [ ] **Step 2: Write failing resend-boundary tests**

Add tests with a factory that creates a second socket after the first socket's send callback fails:

```ts
it("reconnects and resends once when send fails before any event", async () => {
  const { manager, sockets } = createManager({ firstSendError: new Error("stale") });
  const responsePromise = manager.request(requestInput("one"));
  await nextMicrotask();
  queueMicrotask(() =>
    sockets[1].emit("message", JSON.stringify({ type: "response.completed" })),
  );
  await expect((await responsePromise).text()).resolves.toContain("response.completed");
  expect(sockets).toHaveLength(2);
  expect(sockets.map((socket) => socket.sent.length)).toEqual([1, 1]);
});

it("does not reconnect after the first upstream event", async () => {
  const { manager, sockets } = createManager();
  const responsePromise = manager.request(requestInput("one"));
  await nextMicrotask();
  sockets[0].emit("message", JSON.stringify({ type: "response.output_text.delta", delta: "a" }));
  sockets[0].failPendingSend(new Error("late send failure"));
  const response = await responsePromise;
  await expect(response.text()).rejects.toThrow("late send failure");
  expect(sockets).toHaveLength(1);
});

it("stops after the second pre-event send failure", async () => {
  const { manager, sockets } = createManager({ everySendFails: true });
  await expect(manager.request(requestInput("one"))).rejects.toThrow("send failed");
  expect(sockets).toHaveLength(2);
});
```

Adapt the late-failure fake so the callback can be controlled independently from emitted messages.

- [ ] **Step 3: Run WebSocket tests and verify the new cases fail**

Run: `pnpm test src/server/codex/websocket.test.ts`

Expected: failures show no `ping` support, no liveness state, and no resend after a stale send.

- [ ] **Step 4: Implement idle ping/pong liveness**

Extend session state:

```ts
interface CodexWebSocketSession {
  key: string;
  socket: CodexWebSocketLike;
  cleanup?: () => void;
  inFlight: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  awaitingPong: boolean;
}
```

Add `"pong"` to `WebSocketEventName`, optional `ping` to the socket interface, and a constructor default of `30_000` ms. Register one session-level pong handler that clears `awaitingPong`. Replace passive idle waiting with a recursive timeout while the session is idle:

```ts
private scheduleIdleCheck(session: CodexWebSocketSession) {
  if (!this.sessions.has(session.key)) return;
  session.idleTimer = setTimeout(() => {
    if (!this.sessions.has(session.key)) return;
    if (!session.socket.ping) {
      this.scheduleIdleCheck(session);
      return;
    }
    if (session.awaitingPong) {
      this.invalidate(session.key, "terminate");
      return;
    }
    session.awaitingPong = true;
    session.socket.ping((error) => {
      if (error) this.invalidate(session.key, "terminate");
    });
    this.scheduleIdleCheck(session);
  }, Math.min(this.keepAliveIntervalMs, this.idleTimeoutMs));
}
```

Clear this timer and reset `awaitingPong` before each request. Preserve the existing absolute idle expiry for sockets without `ping`, or terminate them once `idleTimeoutMs` elapses.

- [ ] **Step 5: Implement exactly one pre-event reconnect and resend**

Refactor response setup into an async attempt that records whether `onMessage` has observed any event. The send callback resolves a `sent` promise on success. On failure it marks the attempt retryable only when no event was observed. `request` loops over at most two attempts:

```ts
for (let attempt = 0; attempt < 2; attempt += 1) {
  const sessionOrResponse = await this.getOrCreateSession(input);
  if (sessionOrResponse instanceof Response) return sessionOrResponse;
  try {
    return await this.responseFromSession(sessionOrResponse, input.payload);
  } catch (error) {
    if (attempt > 0 || !isRetryableSendFailure(error)) throw error;
    this.invalidate(sessionOrResponse.key, "terminate");
  }
}
throw new Error("Codex websocket send failed after reconnect");
```

Use a private error marker rather than message matching:

```ts
class RetryableWebSocketSendError extends Error {
  readonly retryableBeforeFirstEvent = true;
}
```

When retrying, fully detach the first attempt's listeners and error its unexposed stream. Assign the second session's `inFlight` to its own completion promise before returning its response. Cancellation invalidates the active session and must never enter the retry loop.

- [ ] **Step 6: Run WebSocket tests and commit liveness/retry**

Run: `pnpm test src/server/codex/websocket.test.ts`

Expected: existing reuse tests and all new keepalive/retry tests pass without open timer warnings.

```bash
git add src/server/codex/websocket.ts src/server/codex/websocket.test.ts
git commit -m "fix: harden codex websocket sessions"
```

## Task 4: Classified WebSocket Close Errors

**Files:**
- Modify: `src/server/codex/websocket.ts`
- Modify: `src/server/codex/websocket.test.ts`
- Modify: `src/server/codex/errors.test.ts`

**Interfaces:**
- Produces: private `codexWebSocketCloseError(code: number, reason: unknown): Error & { details: unknown; codexErrorInfo: CodexUpstreamErrorInfo }`.
- Consumed by: single-use and reusable WebSocket close handlers; existing relay `codexErrorInfoFromError` requires no signature change.

- [ ] **Step 1: Write failing close classification tests**

Add a reusable-session test:

```ts
it("classifies an oversized-message close as context scoped", async () => {
  const { manager, sockets } = createManager();
  const response = await manager.request(requestInput("one"));
  sockets[0].emit("close", 1009, Buffer.from("message too big"));

  await expect(response.text()).rejects.toMatchObject({
    codexErrorInfo: {
      code: "context_too_large",
      requestScoped: true,
      credentialScoped: false,
    },
    details: { closeCode: 1009, closeReason: "message too big" },
  });
});
```

Add a classifier regression proving close-shaped bodies preserve usage metadata:

```ts
test("preserves usage reset metadata from a websocket envelope", () => {
  const info = classifyCodexUpstreamError({
    statusCode: 429,
    body: {
      type: "error",
      error: { type: "usage_limit_reached", resets_in_seconds: 30 },
    },
  });
  expect(info).toMatchObject({
    code: "usage_limit_reached",
    retryAfterMs: 30_000,
    credentialScoped: true,
  });
});
```

- [ ] **Step 2: Run focused tests and verify the close test fails**

Run: `pnpm test src/server/codex/websocket.test.ts src/server/codex/errors.test.ts`

Expected: the response currently closes successfully and exposes no classified close error.

- [ ] **Step 3: Implement close error construction**

Import `classifyCodexUpstreamError` and its result type into `websocket.ts`. Decode Buffer/string close reasons, map code `1009` or reason text containing `message too big`, `payload too large`, or `max message size` to a synthetic context body, and attach the classifier result:

```ts
function codexWebSocketCloseError(code: number, rawReason: unknown) {
  const reason = webSocketCloseReason(rawReason);
  const oversized =
    code === 1009 ||
    /message too big|payload too large|max message size/i.test(reason);
  const body = {
    error: {
      code: oversized ? "context_length_exceeded" : "websocket_closed",
      message: reason || `Codex websocket closed with code ${code}`,
    },
  };
  const error = new Error(body.error.message) as Error & {
    details: { closeCode: number; closeReason: string };
    codexErrorInfo: CodexUpstreamErrorInfo;
  };
  error.details = { closeCode: code, closeReason: reason };
  error.codexErrorInfo = classifyCodexUpstreamError({
    statusCode: oversized ? 413 : null,
    body,
  });
  return error;
}
```

Reusable and single-use handlers must error an unfinished response stream with this object. Normal local closure after `response.completed`, caller cancellation, and explicit manager shutdown must remain successful/local and must not fabricate an upstream failure.

- [ ] **Step 4: Run focused tests and commit close classification**

Run: `pnpm test src/server/codex/websocket.test.ts src/server/codex/errors.test.ts`

Expected: all focused tests pass and close metadata reaches `codexErrorInfo`.

```bash
git add src/server/codex/websocket.ts src/server/codex/websocket.test.ts src/server/codex/errors.test.ts
git commit -m "fix: classify codex websocket closes"
```

## Task 5: Full Verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run the complete test suite**

Run: `pnpm test`

Expected: every Vitest file passes with no unhandled rejection or open timer warning.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Run the Next.js production build**

Run: `pnpm build`

Expected: Next.js 16.2.6 compiles successfully and all routes render/build without server-only boundary errors.

- [ ] **Step 4: Review the final patch**

Run: `git diff HEAD~4 --check` and `git diff HEAD~4 --stat`.

Expected: no whitespace errors; changes are limited to the files listed in this plan and the design/plan documents.

- [ ] **Step 5: Record verification in the final commit only if cleanup was required**

If formatting or test cleanup changed files, commit only those concrete changes:

```bash
git add src/server/codex/client.ts src/server/codex/client.test.ts src/server/codex/headerProfiles.ts src/server/codex/headerProfiles.test.ts src/server/config/env.ts src/server/codex/websocket.ts src/server/codex/websocket.test.ts src/server/codex/errors.test.ts README.md
git commit -m "test: verify codex compatibility core"
```

If verification changed nothing, do not create an empty commit.
